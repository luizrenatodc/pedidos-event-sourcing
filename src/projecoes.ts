import type { Evento, Loja } from "./loja.ts";

/** Modelos de leitura. Podem ser apagados e recriados a qualquer momento a partir do log de eventos. */
export class Projecoes {
  #loja: Loja;

  constructor(loja: Loja) {
    this.#loja = loja;
    this.#criar();
  }

  #criar() {
    this.#loja.db.exec(`
      CREATE TABLE IF NOT EXISTS v_pedidos (id TEXT PRIMARY KEY, cliente TEXT, total REAL, status TEXT, motivo TEXT, rastreio TEXT, criado_em TEXT);
      CREATE TABLE IF NOT EXISTS v_estoque (sku TEXT PRIMARY KEY, disponivel INTEGER NOT NULL DEFAULT 0, reservado INTEGER NOT NULL DEFAULT 0);
    `);
  }

  aplicar(e: Evento): void {
    const db = this.#loja.db;
    const id = e.fluxo.replace(/^pedido-/, "");
    const status = (s: string) => db.prepare("UPDATE v_pedidos SET status = ? WHERE id = ?").run(s, id);
    const sku = e.fluxo.replace(/^estoque-/, "");
    const saldo = (d: number, r: number) => db.prepare("INSERT INTO v_estoque (sku, disponivel, reservado) VALUES (?, ?, ?) ON CONFLICT(sku) DO UPDATE SET disponivel = disponivel + excluded.disponivel, reservado = reservado + excluded.reservado").run(sku, d, r);
    switch (e.tipo) {
      case "PedidoCriado":
        db.prepare("INSERT OR REPLACE INTO v_pedidos (id, cliente, total, status, criado_em) VALUES (?, ?, ?, 'criado', ?)").run(id, e.dados.cliente, e.dados.total, e.em);
        break;
      case "EstoqueReservado": status("reservado"); break;
      case "PagamentoAprovado": status("pago"); break;
      case "PagamentoRecusado": status("pagamento recusado"); break;
      case "PedidoEnviado":
        db.prepare("UPDATE v_pedidos SET status = 'enviado', rastreio = ? WHERE id = ?").run(e.dados.rastreio, id);
        break;
      case "PedidoCancelado":
        db.prepare("UPDATE v_pedidos SET status = 'cancelado', motivo = ? WHERE id = ?").run(e.dados.motivo, id);
        break;
      case "EstoqueAbastecido": saldo(e.dados.quantidade, 0); break;
      case "ItemReservado": saldo(-e.dados.quantidade, e.dados.quantidade); break;
      case "ItemLiberado": saldo(e.dados.quantidade, -e.dados.quantidade); break;
    }
  }

  reconstruir(): number {
    const db = this.#loja.db;
    db.exec("DROP TABLE v_pedidos; DROP TABLE v_estoque;");
    this.#criar();
    const eventos = this.#loja.todos();
    for (const e of eventos) this.aplicar(e);
    return eventos.length;
  }

  pedidos() {
    return this.#loja.db.prepare("SELECT * FROM v_pedidos ORDER BY criado_em DESC").all();
  }

  estoque() {
    return this.#loja.db.prepare("SELECT * FROM v_estoque ORDER BY sku").all();
  }

  resumo() {
    return this.#loja.db.prepare("SELECT COUNT(*) AS pedidos, COALESCE(SUM(CASE WHEN status = 'enviado' THEN total END), 0) AS receita, COALESCE(SUM(status = 'enviado'), 0) AS enviados, COALESCE(SUM(status = 'cancelado'), 0) AS cancelados FROM v_pedidos").get();
  }
}
