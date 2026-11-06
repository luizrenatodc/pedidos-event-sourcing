import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Aplicacao } from "./aplicacao.ts";
import { CATALOGO, gatewayDemo, semear } from "./demo.ts";
import { Loja } from "./loja.ts";

const PUBLICO = join(import.meta.dirname, "..", "public");
const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

const loja = new Loja(process.env.BANCO ?? "pedidos.db");
const app = new Aplicacao(loja, gatewayDemo());
if (!loja.todos().length) await semear(app);
setInterval(() => app.despachar().catch(console.error), 500).unref();

const json = (res: ServerResponse, status: number, corpo: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(corpo));
async function ler(req: IncomingMessage) {
  let t = "";
  for await (const p of req) t += p;
  return t ? JSON.parse(t) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const rota = `${req.method} ${url.pathname}`;
  try {
    if (rota === "GET /api/painel") {
      return json(res, 200, { pedidos: app.projecoes.pedidos(), estoque: app.projecoes.estoque(), resumo: app.projecoes.resumo(), saude: app.saude(), recentes: loja.recentes(14), catalogo: CATALOGO });
    }
    if (rota === "POST /api/pedidos") {
      const { cliente, sku, quantidade, cartao } = await ler(req);
      const produto = CATALOGO.find((c) => c.sku === sku);
      if (!produto) return json(res, 404, { erro: "Produto não encontrado" });
      const id = app.criarPedido(String(cliente), [{ sku, quantidade: Number(quantidade), preco: produto.preco }], String(cartao));
      await app.despachar();
      return json(res, 201, { id });
    }
    if (rota === "POST /api/reconstruir") return json(res, 200, { eventos: app.projecoes.reconstruir() });
    const d = url.pathname.match(/^\/api\/pedidos\/([\w-]+)$/);
    if (d && req.method === "GET") {
      const eventos = loja.ler(`pedido-${d[1]}`);
      if (!eventos.length) return json(res, 404, { erro: "Não encontrado" });
      const versao = url.searchParams.get("versao");
      return json(res, 200, { eventos, estado: app.estadoPedido(d[1], versao ? Number(versao) : undefined) });
    }
    if (req.method !== "GET") return json(res, 404, { erro: "Rota inexistente" });
    const arquivo = normalize(url.pathname === "/" ? "index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const conteudo = await readFile(join(PUBLICO, arquivo));
    res.writeHead(200, { "content-type": TIPOS[extname(arquivo)] ?? "text/plain" }).end(conteudo);
  } catch (erro) {
    const e = erro as NodeJS.ErrnoException;
    json(res, e.code === "ENOENT" ? 404 : 400, { erro: e.message });
  }
}).listen(Number(process.env.PORTA ?? 3000), () => console.log("Painel no ar"));
