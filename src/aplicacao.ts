import { randomUUID } from "node:crypto";
import { decidirPedido, ESTOQUE_VAZIO, evoluirEstoque, evoluirPedido, liberarItem, PEDIDO_VAZIO, reservarItem, type Comando, type EstadoEstoque, type EstadoPedido, type Item } from "./dominio.ts";
import { ConflitoDeVersao, Loja, type Evento, type NovoEvento } from "./loja.ts";
import { Projecoes } from "./projecoes.ts";

export type Gateway = { cobrar(chave: string, valor: number, cartao: string): Promise<{ aprovado: boolean; transacao?: string; motivo?: string }> };

type Consumidor = { nome: string; tratar(evento: Evento): Promise<void> | void };

const fluxoPedido = (id: string) => `pedido-${id}`;
const fluxoEstoque = (sku: string) => `estoque-${sku}`;

export class Aplicacao {
  loja: Loja;
  projecoes: Projecoes;
  #gateway: Gateway;
  #consumidores: Consumidor[];
  #maxTentativas: number;

  constructor(loja: Loja, gateway: Gateway, maxTentativas = 5) {
    this.loja = loja;
    this.projecoes = new Projecoes(loja);
    this.#gateway = gateway;
    this.#maxTentativas = maxTentativas;
    this.#consumidores = [
      { nome: "projecoes", tratar: (e) => this.projecoes.aplicar(e) },
      { nome: "saga", tratar: (e) => this.#saga(e) },
    ];
  }

  estadoPedido(id: string, ateVersao?: number): EstadoPedido {
    return this.loja.ler(fluxoPedido(id), ateVersao).reduce(evoluirPedido, PEDIDO_VAZIO);
  }

  estadoEstoque(sku: string): EstadoEstoque {
    return this.loja.ler(fluxoEstoque(sku)).reduce(evoluirEstoque, ESTOQUE_VAZIO);
  }

  /** Carrega, decide e grava. Se outro processo gravou antes, relê o estado e decide de novo. */
  #executar<E>(fluxo: string, carregar: () => E, decidir: (estado: E) => NovoEvento[]): Evento[] {
    for (let tentativa = 0; ; tentativa++) {
      const versao = this.loja.versao(fluxo);
      try {
        return this.loja.anexar(fluxo, versao, decidir(carregar()));
      } catch (erro) {
        if (!(erro instanceof ConflitoDeVersao) || tentativa >= 3) throw erro;
      }
    }
  }

  comandar(id: string, comando: Comando): Evento[] {
    return this.#executar(fluxoPedido(id), () => this.estadoPedido(id), (e) => decidirPedido(e, comando));
  }

  abastecer(sku: string, quantidade: number): void {
    this.loja.anexar(fluxoEstoque(sku), this.loja.versao(fluxoEstoque(sku)), [{ tipo: "EstoqueAbastecido", dados: { sku, quantidade } }]);
  }

  criarPedido(cliente: string, itens: Item[], cartao: string, id: string = randomUUID().slice(0, 8)): string {
    this.comandar(id, { tipo: "criar", cliente, itens, cartao });
    return id;
  }

  /** Reserva item a item. Se um faltar, devolve os que já tinham sido reservados. */
  #reservarTudo(id: string, itens: Item[]): boolean {
    const reservados: string[] = [];
    for (const item of itens) {
      let faltou = false;
      this.#executar(fluxoEstoque(item.sku), () => this.estadoEstoque(item.sku), (e) => {
        const r = reservarItem(e, id, item.quantidade);
        faltou = r === "sem_estoque";
        return r === "sem_estoque" ? [] : r;
      });
      if (faltou) {
        this.#liberar(id, reservados);
        return false;
      }
      reservados.push(item.sku);
    }
    return true;
  }

  #liberar(id: string, skus: string[]): void {
    for (const sku of skus) this.#executar(fluxoEstoque(sku), () => this.estadoEstoque(sku), (e) => liberarItem(e, id));
  }

  async #saga(evento: Evento): Promise<void> {
    if (!evento.fluxo.startsWith("pedido-")) return;
    const id = evento.fluxo.slice("pedido-".length);
    const pedido = this.estadoPedido(id);
    switch (evento.tipo) {
      case "PedidoCriado":
        if (pedido.status !== "criado") return;
        if (this.#reservarTudo(id, pedido.itens)) this.comandar(id, { tipo: "reservar" });
        else this.comandar(id, { tipo: "cancelar", motivo: "Sem estoque" });
        return;
      case "EstoqueReservado": {
        if (pedido.status !== "reservado") return;
        const r = await this.#gateway.cobrar(id, pedido.total, pedido.cartao ?? "");
        if (r.aprovado) this.comandar(id, { tipo: "aprovar", transacao: r.transacao ?? "" });
        else this.comandar(id, { tipo: "recusar", motivo: r.motivo ?? "Recusado" });
        return;
      }
      case "PagamentoAprovado":
        this.comandar(id, { tipo: "enviar", rastreio: `BR${id.slice(0, 6).toUpperCase()}` });
        return;
      case "PagamentoRecusado":
        this.#liberar(id, pedido.itens.map((i) => i.sku));
        this.comandar(id, { tipo: "cancelar", motivo: evento.dados.motivo });
        return;
    }
  }

  /** Entrega pelo menos uma vez, na ordem. Um consumidor que já tratou o evento é ignorado. */
  async despachar(): Promise<number> {
    let entregues = 0;
    while (true) {
      const linha = this.loja.db.prepare("SELECT posicao, tentativas FROM outbox WHERE estado = 'pendente' ORDER BY posicao LIMIT 1").get() as { posicao: number; tentativas: number } | undefined;
      if (!linha) return entregues;
      const evento = this.loja.todos(linha.posicao - 1)[0];
      try {
        for (const c of this.#consumidores) await this.entregar(c.nome, evento);
        this.loja.db.prepare("UPDATE outbox SET estado = 'entregue', erro = NULL WHERE posicao = ?").run(linha.posicao);
        entregues++;
      } catch (erro) {
        const tentativas = linha.tentativas + 1;
        const estado = tentativas >= this.#maxTentativas ? "morta" : "pendente";
        this.loja.db.prepare("UPDATE outbox SET tentativas = ?, estado = ?, erro = ? WHERE posicao = ?").run(tentativas, estado, (erro as Error).message, linha.posicao);
      }
    }
  }

  async entregar(nome: string, evento: Evento): Promise<void> {
    const ja = this.loja.db.prepare("SELECT 1 FROM processados WHERE consumidor = ? AND evento_id = ?").get(nome, evento.id);
    if (ja) return;
    await this.#consumidores.find((c) => c.nome === nome)!.tratar(evento);
    this.loja.db.prepare("INSERT INTO processados (consumidor, evento_id) VALUES (?, ?)").run(nome, evento.id);
  }

  saude() {
    return {
      outbox: this.loja.db.prepare("SELECT estado, COUNT(*) AS total FROM outbox GROUP BY estado").all(),
      retentativas: (this.loja.db.prepare("SELECT COALESCE(SUM(tentativas), 0) AS t FROM outbox").get() as { t: number }).t,
      mortas: this.loja.db.prepare("SELECT e.tipo, e.fluxo, o.erro FROM outbox o JOIN eventos e USING (posicao) WHERE o.estado = 'morta'").all(),
    };
  }
}
