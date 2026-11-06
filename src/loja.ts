import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type NovoEvento = { tipo: string; dados: Record<string, any> };
export type Evento = NovoEvento & { posicao: number; id: string; fluxo: string; versao: number; em: string };

export class ConflitoDeVersao extends Error {}

type Linha = Omit<Evento, "dados"> & { dados: string };
const paraEvento = (l: Linha): Evento => ({ ...l, dados: JSON.parse(l.dados) });

/** Log de eventos só de inclusão. O evento e sua entrada na outbox são gravados na mesma transação. */
export class Loja {
  db: DatabaseSync;

  constructor(caminho = ":memory:") {
    this.db = new DatabaseSync(caminho);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS eventos (
        posicao INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, fluxo TEXT NOT NULL, versao INTEGER NOT NULL,
        tipo TEXT NOT NULL, dados TEXT NOT NULL, em TEXT NOT NULL, UNIQUE (fluxo, versao)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        posicao INTEGER PRIMARY KEY REFERENCES eventos(posicao), tentativas INTEGER NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'pendente', erro TEXT
      );
      CREATE TABLE IF NOT EXISTS processados (consumidor TEXT NOT NULL, evento_id TEXT NOT NULL, PRIMARY KEY (consumidor, evento_id));
    `);
  }

  anexar(fluxo: string, versaoEsperada: number, novos: NovoEvento[]): Evento[] {
    if (!novos.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const atual = this.versao(fluxo);
      if (atual !== versaoEsperada) throw new ConflitoDeVersao(`${fluxo}: esperava ${versaoEsperada}, encontrou ${atual}`);
      const gravados = novos.map((e, i) => {
        const { lastInsertRowid } = this.db
          .prepare("INSERT INTO eventos (id, fluxo, versao, tipo, dados, em) VALUES (?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), fluxo, atual + i + 1, e.tipo, JSON.stringify(e.dados), new Date().toISOString());
        this.db.prepare("INSERT INTO outbox (posicao) VALUES (?)").run(lastInsertRowid);
        return paraEvento(this.db.prepare("SELECT * FROM eventos WHERE posicao = ?").get(lastInsertRowid) as Linha);
      });
      this.db.exec("COMMIT");
      return gravados;
    } catch (erro) {
      this.db.exec("ROLLBACK");
      throw erro;
    }
  }

  versao(fluxo: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(versao), 0) AS v FROM eventos WHERE fluxo = ?").get(fluxo) as { v: number }).v;
  }

  ler(fluxo: string, ateVersao = Number.MAX_SAFE_INTEGER): Evento[] {
    return (this.db.prepare("SELECT * FROM eventos WHERE fluxo = ? AND versao <= ? ORDER BY versao").all(fluxo, ateVersao) as Linha[]).map(paraEvento);
  }

  todos(depois = 0): Evento[] {
    return (this.db.prepare("SELECT * FROM eventos WHERE posicao > ? ORDER BY posicao").all(depois) as Linha[]).map(paraEvento);
  }

  recentes(limite: number): Evento[] {
    return (this.db.prepare("SELECT * FROM eventos ORDER BY posicao DESC LIMIT ?").all(limite) as Linha[]).map(paraEvento);
  }
}
