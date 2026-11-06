import assert from "node:assert/strict";
import { test } from "node:test";
import { decidirPedido, evoluirEstoque, ESTOQUE_VAZIO, evoluirPedido, liberarItem, PEDIDO_VAZIO, reservarItem, type EstadoPedido } from "../src/dominio.ts";

const item = { sku: "a", quantidade: 2, preco: 10.1 };
const no = (status: EstadoPedido["status"]): EstadoPedido => ({ ...PEDIDO_VAZIO, status });

test("calcula o total sem erro de arredondamento", () => {
  const [e] = decidirPedido(PEDIDO_VAZIO, { tipo: "criar", cliente: "c", itens: [item], cartao: "1" });
  assert.equal(e.dados.total, 20.2);
});

test("recusa pedido vazio ou com item inválido", () => {
  assert.throws(() => decidirPedido(PEDIDO_VAZIO, { tipo: "criar", cliente: "c", itens: [], cartao: "1" }), /sem itens/);
  assert.throws(() => decidirPedido(PEDIDO_VAZIO, { tipo: "criar", cliente: "c", itens: [{ ...item, quantidade: 0 }], cartao: "1" }), /inválido/);
});

test("repetir comando já aplicado não gera evento", () => {
  assert.deepEqual(decidirPedido(no("pago"), { tipo: "aprovar", transacao: "t" }), []);
  assert.deepEqual(decidirPedido(no("enviado"), { tipo: "enviar", rastreio: "r" }), []);
  assert.deepEqual(decidirPedido(no("cancelado"), { tipo: "cancelar", motivo: "m" }), []);
});

test("impede transições fora de ordem", () => {
  assert.throws(() => decidirPedido(no("criado"), { tipo: "enviar", rastreio: "r" }), /inválido/);
  assert.throws(() => decidirPedido(no("cancelado"), { tipo: "aprovar", transacao: "t" }), /inválido/);
  assert.throws(() => decidirPedido(no("enviado"), { tipo: "cancelar", motivo: "m" }), /não pode ser cancelado/);
});

test("estado é o resultado de aplicar os eventos em ordem", () => {
  const eventos = [{ tipo: "PedidoCriado", dados: { cliente: "c", itens: [], total: 5, cartao: "1" } }, { tipo: "EstoqueReservado", dados: {} }, { tipo: "PagamentoAprovado", dados: { transacao: "t" } }];
  const e = eventos.reduce(evoluirPedido, PEDIDO_VAZIO);
  assert.equal(e.status, "pago");
  assert.equal(e.transacao, "t");
});

test("estoque reserva uma vez por pedido e recusa acima do saldo", () => {
  const e = evoluirEstoque(ESTOQUE_VAZIO, { tipo: "EstoqueAbastecido", dados: { quantidade: 3 } });
  assert.equal(reservarItem(e, "p", 4), "sem_estoque");
  const reservado = evoluirEstoque(e, (reservarItem(e, "p", 2) as { tipo: string; dados: object }[])[0]);
  assert.equal(reservado.disponivel, 1);
  assert.deepEqual(reservarItem(reservado, "p", 2), []);
});

test("liberar devolve o saldo e repetir não duplica", () => {
  const e = { disponivel: 1, reservas: { p: 2 } };
  const liberado = evoluirEstoque(e, liberarItem(e, "p")[0]);
  assert.equal(liberado.disponivel, 3);
  assert.deepEqual(liberarItem(liberado, "p"), []);
});
