import type { Aplicacao, Gateway } from "./aplicacao.ts";

/** Gateway simulado: cartão final 0000 é recusado e final 5030 falha uma vez antes de aprovar. */
export function gatewayDemo(): Gateway {
  const cobrancas = new Map<string, string>();
  const falhas = new Set<string>();
  return {
    async cobrar(chave, _valor, cartao) {
      if (cartao.endsWith("0000")) return { aprovado: false, motivo: "Cartão recusado pelo emissor" };
      if (cartao.endsWith("5030") && !falhas.has(chave)) {
        falhas.add(chave);
        throw new Error("Gateway indisponível (503)");
      }
      if (!cobrancas.has(chave)) cobrancas.set(chave, `TX-${cobrancas.size + 1001}`);
      return { aprovado: true, transacao: cobrancas.get(chave) };
    },
  };
}

export const CATALOGO = [
  { sku: "teclado", nome: "Teclado mecânico", preco: 389.9, estoque: 12 },
  { sku: "mouse", nome: "Mouse sem fio", preco: 159, estoque: 20 },
  { sku: "monitor", nome: "Monitor 27 polegadas", preco: 1499, estoque: 3 },
  { sku: "headset", nome: "Headset USB", preco: 279.5, estoque: 8 },
];

const item = (sku: string, quantidade: number) => ({ sku, quantidade, preco: CATALOGO.find((c) => c.sku === sku)!.preco });

export async function semear(app: Aplicacao) {
  for (const c of CATALOGO) app.abastecer(c.sku, c.estoque);
  await app.despachar();
  const pedidos: [string, ReturnType<typeof item>[], string][] = [
    ["Marina Lopes", [item("teclado", 1), item("mouse", 1)], "4111"],
    ["Paulo Reis", [item("monitor", 2)], "4242"],
    ["Júlia Prado", [item("headset", 2)], "0000"],
    ["André Nunes", [item("mouse", 1), item("monitor", 5)], "4111"],
    ["Carla Dias", [item("teclado", 2)], "5030"],
    ["Rafael Melo", [item("headset", 1), item("mouse", 2)], "4242"],
  ];
  for (const [cliente, itens, cartao] of pedidos) {
    app.criarPedido(cliente, itens, cartao);
    await app.despachar();
  }
}
