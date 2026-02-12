export interface DbPreparedStatement {
  bind(...params: unknown[]): DbPreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<void>;
}

export interface DbClient {
  prepare(sql: string): DbPreparedStatement;
  batch(statements: DbPreparedStatement[]): Promise<void>;
}
