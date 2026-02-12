import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DbClient, DbPreparedStatement } from "./db-client";

class SqlitePreparedStatement implements DbPreparedStatement {
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): DbPreparedStatement {
    return new SqlitePreparedStatement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as T | undefined;
    return row ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows };
  }

  async run(): Promise<void> {
    this.executeRun();
  }

  executeRun(): void {
    this.db.prepare(this.sql).run(...this.params);
  }
}

export class SqliteDbClient implements DbClient {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string): DbPreparedStatement {
    return new SqlitePreparedStatement(this.db, sql);
  }

  async batch(statements: DbPreparedStatement[]): Promise<void> {
    const tx = this.db.transaction((items: DbPreparedStatement[]) => {
      for (const item of items) {
        if (!(item instanceof SqlitePreparedStatement)) {
          throw new Error("Invalid statement type for sqlite batch");
        }
        item.executeRun();
      }
    });

    tx(statements);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  get raw(): Database.Database {
    return this.db;
  }
}

export function createSqliteClient(dbPath: string): SqliteDbClient {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return new SqliteDbClient(db);
}

export function applySqlMigrations(client: SqliteDbClient, migrationsDir: string): void {
  const dir = path.resolve(migrationsDir);
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  client.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const applied = new Set<string>(
    (client.raw
      .prepare("SELECT name FROM _migrations")
      .all() as Array<{ name: string }>).map((row) => row.name)
  );

  const markApplied = client.raw.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    client.exec(sql);
    markApplied.run(file, Date.now());
  }
}
