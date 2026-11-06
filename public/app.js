const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const brl = (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const api = async (u, o) => (await fetch(u, o)).json();
const SELO = { enviado: "ok", cancelado: "erro", criado: "info", reservado: "info", pago: "lilas" };
let ativo, carregou;

async function carregar() {
  const p = await api("/api/painel");
  const r = p.resumo;
  const entregues = p.saude.outbox.find((o) => o.estado === "entregue")?.total ?? 0;
  $("#kpis").innerHTML = [
    ["Receita enviada", brl(r.receita), `${r.enviados} pedidos entregues à transportadora`],
    ["Pedidos cancelados", r.cancelados, "com estoque devolvido pela saga"],
    ["Eventos entregues", entregues, `${p.saude.mortas.length} em fila morta`],
    ["Novas tentativas", p.saude.retentativas, "falhas recuperadas pela outbox"],
  ].map(([a, b, c]) => `<div class="cartao kpi"><div class="rotulo">${a}</div><div class="valor">${b}</div><div class="nota">${c}</div></div>`).join("");

  if (!carregou) {
    carregou = true;
    $("#sku").innerHTML = p.catalogo.map((c) => `<option value="${c.sku}">${esc(c.nome)}</option>`).join("");
  }
  if (!ativo && p.pedidos.length) ativo = (p.pedidos.find((x) => x.motivo?.includes("Cartão")) ?? p.pedidos[0]).id;
  $("#pedidos").innerHTML = p.pedidos.map((x) => `<tr data-id="${x.id}" class="${x.id === ativo ? "ativo" : ""}"><td>${esc(x.cliente)}<br><small class="nevoa mono">${x.id}</small></td><td>${brl(x.total)}</td><td><span class="selo ${SELO[x.status] ?? ""}">${esc(x.status)}</span>${x.motivo ? `<br><small class="nevoa">${esc(x.motivo)}</small>` : ""}</td></tr>`).join("");
  $("#estoque").innerHTML = p.estoque.map((e) => {
    const total = Math.max(1, e.disponivel + e.reservado);
    return `<div style="margin-bottom:10px"><div class="linha" style="justify-content:space-between"><span>${esc(e.sku)}</span><span class="nevoa mono">${e.disponivel} livres · ${e.reservado} reserv.</span></div><div class="medidor"><i style="width:${(e.disponivel / total) * 100}%;background:var(--acento)"></i><i style="width:${(e.reservado / total) * 100}%;background:var(--ambar)"></i></div></div>`;
  }).join("");
  $("#log").innerHTML = p.recentes.slice(0, 7).map((e) => `<div class="evento"><span class="versao">#${e.posicao}</span><div><b>${esc(e.tipo)}</b><span class="fluxo"> ${esc(e.fluxo)}</span></div></div>`).join("");
  if (ativo) await detalhe();
}

function resumo(e) {
  const d = e.dados;
  if (e.tipo === "PedidoCriado") return `${d.cliente} · ${brl(d.total)} · cartão final ${d.cartao}`;
  return d.motivo ?? d.transacao ?? d.rastreio ?? "";
}

async function detalhe() {
  const { eventos, estado } = await api(`/api/pedidos/${ativo}`);
  $("#tituloEventos").textContent = `Eventos do pedido ${ativo}`;
  $("#eventos").innerHTML = eventos.map((e) => `<div class="evento"><span class="versao">v${e.versao}</span><div><b>${esc(e.tipo)}</b><small>${esc(resumo(e))}</small></div></div>`).join("") +
    `<p class="nevoa" style="margin-top:10px">Estado calculado: <span class="selo ${SELO[estado.status] ?? ""}">${esc(estado.status)}</span></p>`;
}

$("#pedidos").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr");
  if (tr) { ativo = tr.dataset.id; carregar(); }
});
$("#novo").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const { id } = await api("/api/pedidos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cliente: $("#cliente").value, sku: $("#sku").value, quantidade: $("#qtd").value, cartao: $("#cartao").value }) });
  ativo = id;
  setTimeout(carregar, 700);
});
$("#reconstruir").addEventListener("click", async () => {
  const { eventos } = await api("/api/reconstruir", { method: "POST" });
  $("#aviso").textContent = `${eventos} eventos reaplicados`;
  carregar();
});
carregar();
setInterval(carregar, 3000);
