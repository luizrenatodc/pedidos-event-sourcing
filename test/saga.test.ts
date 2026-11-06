import assert from "node:assert/strict";
import { test } from "node:test";
import { Aplicacao } from "../src/aplicacao.ts";
import { gatewayDemo } from "../src/demo.ts";
import { ConflitoDeVersao, Loja } from "../src/loja.ts";

function montar(gateway = gatewayDemo(), maxTentativas = 5) {
  const loja = new Loja();
  const app = new Aplicacao(loja, gateway, maxTentativas);
  app.abastecer("a", 5);
  app.abastecer("b", 1);
  return { app, loja };
}
const item = (sku: string, quantidade = 1) => ({ sku, quantidade, preco: 100 });
const tipos = (loja: Loja, id: string) => loja.ler(`pedido-${id}`).map((e) => e.tipo);

test("loja recusa gravação com versão desatualizada", () => {
  const loja = new Loja();
  loja.anexar("x", 0, [{ tipo: "A", dados: {} }]);
  assert.throws(() => loja.anexar("x", 0, [{ tipo: "B", dados: {} }]), ConflitoDeVersao);
  assert.equal(loja.ler("x").length, 1);
});

test("evento e outbox entram juntos ou nenhum entra", () => {
  const loja = new Loja();
  loja.anexar("x", 0, [{ tipo: "A", dados: {} }]);
  assert.throws(() => loja.anexar("x", 9, [{ tipo: "B", dados: {} }]));
  const { n } = loja.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
  assert.equal(n, 1);
});

test("caminho feliz leva o pedido até o envio", async () => {
  const { app, loja } = montar();
  const id = app.criarPedido("c", [item("a", 2)], "4111");
  await app.despachar();
  assert.deepEqual(tipos(loja, id), ["PedidoCriado", "EstoqueReservado", "PagamentoAprovado", "PedidoEnviado"]);
  assert.equal(app.estadoEstoque("a").disponivel, 3);
});

test("pagamento recusado devolve o estoque e cancela", async () => {
  const { app } = montar();
  const id = app.criarPedido("c", [item("a", 2)], "0000");
  await app.despachar();
  assert.equal(app.estadoPedido(id).status, "cancelado");
  assert.equal(app.estadoEstoque("a").disponivel, 5);
});

test("falta de um item desfaz a reserva dos anteriores", async () => {
  const { app } = montar();
  const id = app.criarPedido("c", [item("a", 2), item("b", 3)], "4111");
  await app.despachar();
  assert.equal(app.estadoPedido(id).motivo, "Sem estoque");
  assert.equal(app.estadoEstoque("a").disponivel, 5);
});

test("não vende além do estoque", async () => {
  const { app } = montar();
  const primeiro = app.criarPedido("c", [item("b")], "4111");
  const segundo = app.criarPedido("d", [item("b")], "4111");
  await app.despachar();
  assert.equal(app.estadoPedido(primeiro).status, "enviado");
  assert.equal(app.estadoPedido(segundo).status, "cancelado");
  assert.equal(app.estadoEstoque("b").disponivel, 0);
});

test("gateway instável é tentado de novo e cobra uma vez só", async () => {
  const { app, loja } = montar();
  const id = app.criarPedido("c", [item("a")], "5030");
  await app.despachar();
  assert.equal(app.estadoPedido(id).status, "enviado");
  assert.equal(tipos(loja, id).filter((t) => t === "PagamentoAprovado").length, 1);
  assert.equal(app.saude().retentativas, 1);
});

test("reentrega do mesmo evento não muda nada", async () => {
  const { app, loja } = montar();
  const id = app.criarPedido("c", [item("a")], "4111");
  await app.despachar();
  const antes = loja.todos().length;
  for (const e of loja.todos()) await app.entregar("saga", e);
  loja.db.exec("DELETE FROM processados");
  for (const e of loja.todos()) await app.entregar("saga", e);
  assert.equal(loja.todos().length, antes);
  assert.equal(app.estadoEstoque("a").disponivel, 4);
  assert.equal(app.estadoPedido(id).status, "enviado");
});

test("evento que sempre falha vai para a fila morta sem travar os demais", async () => {
  const quebrado = { cobrar: async () => { throw new Error("fora do ar"); } };
  const { app } = montar(quebrado, 2);
  const id = app.criarPedido("c", [item("a")], "4111");
  await app.despachar();
  assert.equal(app.estadoPedido(id).status, "reservado");
  assert.equal(app.saude().mortas.length, 1);
});

test("projeções recriadas do zero ficam idênticas", async () => {
  const { app } = montar();
  app.criarPedido("c", [item("a", 2)], "4111", "p1");
  app.criarPedido("d", [item("a")], "0000", "p2");
  await app.despachar();
  const antes = [app.projecoes.pedidos(), app.projecoes.estoque()];
  app.projecoes.reconstruir();
  assert.deepEqual([app.projecoes.pedidos(), app.projecoes.estoque()], antes);
});

test("consulta o estado do pedido em qualquer versão", async () => {
  const { app } = montar();
  const id = app.criarPedido("c", [item("a")], "4111");
  await app.despachar();
  assert.equal(app.estadoPedido(id, 1).status, "criado");
  assert.equal(app.estadoPedido(id, 3).status, "pago");
  assert.equal(app.estadoPedido(id).status, "enviado");
});
