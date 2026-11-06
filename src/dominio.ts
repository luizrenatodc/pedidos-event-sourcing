import type { Evento, NovoEvento } from "./loja.ts";

export type Item = { sku: string; quantidade: number; preco: number };
export type EstadoPedido = {
  status: "novo" | "criado" | "reservado" | "pago" | "enviado" | "cancelado";
  cliente?: string;
  itens: Item[];
  total: number;
  cartao?: string;
  transacao?: string;
  rastreio?: string;
  motivo?: string;
};

export const PEDIDO_VAZIO: EstadoPedido = { status: "novo", itens: [], total: 0 };

export function evoluirPedido(e: EstadoPedido, ev: Pick<Evento, "tipo" | "dados">): EstadoPedido {
  const d = ev.dados;
  switch (ev.tipo) {
    case "PedidoCriado": return { ...e, status: "criado", cliente: d.cliente, itens: d.itens, total: d.total, cartao: d.cartao };
    case "EstoqueReservado": return { ...e, status: "reservado" };
    case "PagamentoAprovado": return { ...e, status: "pago", transacao: d.transacao };
    case "PedidoEnviado": return { ...e, status: "enviado", rastreio: d.rastreio };
    case "PedidoCancelado": return { ...e, status: "cancelado", motivo: d.motivo };
    default: return e;
  }
}

export type Comando =
  | { tipo: "criar"; cliente: string; itens: Item[]; cartao: string }
  | { tipo: "reservar" }
  | { tipo: "aprovar"; transacao: string }
  | { tipo: "recusar"; motivo: string }
  | { tipo: "enviar"; rastreio: string }
  | { tipo: "cancelar"; motivo: string };

/**
 * Decide quais eventos um comando gera. Repetir um comando já aplicado devolve lista vazia,
 * o que torna cada etapa da saga segura para reentrega.
 */
export function decidirPedido(e: EstadoPedido, c: Comando): NovoEvento[] {
  const invalido = () => { throw new Error(`Comando ${c.tipo} inválido em pedido ${e.status}`); };
  switch (c.tipo) {
    case "criar": {
      if (e.status !== "novo") return [];
      if (!c.itens.length) throw new Error("Pedido sem itens");
      if (c.itens.some((i) => i.quantidade <= 0 || i.preco < 0)) throw new Error("Item inválido");
      const total = Math.round(c.itens.reduce((s, i) => s + i.quantidade * i.preco, 0) * 100) / 100;
      return [{ tipo: "PedidoCriado", dados: { cliente: c.cliente, itens: c.itens, total, cartao: c.cartao } }];
    }
    case "reservar":
      if (e.status === "criado") return [{ tipo: "EstoqueReservado", dados: {} }];
      return e.status === "cancelado" || e.status === "novo" ? invalido() : [];
    case "aprovar":
      if (e.status === "reservado") return [{ tipo: "PagamentoAprovado", dados: { transacao: c.transacao } }];
      return e.status === "pago" || e.status === "enviado" ? [] : invalido();
    case "recusar":
      if (e.status === "reservado") return [{ tipo: "PagamentoRecusado", dados: { motivo: c.motivo } }];
      return e.status === "cancelado" ? [] : invalido();
    case "enviar":
      if (e.status === "pago") return [{ tipo: "PedidoEnviado", dados: { rastreio: c.rastreio } }];
      return e.status === "enviado" ? [] : invalido();
    case "cancelar":
      if (e.status === "cancelado") return [];
      if (e.status === "enviado") throw new Error("Pedido enviado não pode ser cancelado");
      return [{ tipo: "PedidoCancelado", dados: { motivo: c.motivo } }];
  }
}

export type EstadoEstoque = { disponivel: number; reservas: Record<string, number> };
export const ESTOQUE_VAZIO: EstadoEstoque = { disponivel: 0, reservas: {} };

export function evoluirEstoque(e: EstadoEstoque, ev: Pick<Evento, "tipo" | "dados">): EstadoEstoque {
  const d = ev.dados;
  if (ev.tipo === "EstoqueAbastecido") return { ...e, disponivel: e.disponivel + d.quantidade };
  if (ev.tipo === "ItemReservado") return { disponivel: e.disponivel - d.quantidade, reservas: { ...e.reservas, [d.pedido]: d.quantidade } };
  if (ev.tipo === "ItemLiberado") {
    const { [d.pedido]: _, ...reservas } = e.reservas;
    return { disponivel: e.disponivel + d.quantidade, reservas };
  }
  return e;
}

export function reservarItem(e: EstadoEstoque, pedido: string, quantidade: number): NovoEvento[] | "sem_estoque" {
  if (pedido in e.reservas) return [];
  if (e.disponivel < quantidade) return "sem_estoque";
  return [{ tipo: "ItemReservado", dados: { pedido, quantidade } }];
}

export function liberarItem(e: EstadoEstoque, pedido: string): NovoEvento[] {
  const quantidade = e.reservas[pedido];
  return quantidade ? [{ tipo: "ItemLiberado", dados: { pedido, quantidade } }] : [];
}
