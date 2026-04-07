declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string): Statement;
    exec(sql: string): unknown;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    bind(params?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    run(params?: unknown[]): void;
    free(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  function initSqlJs(): Promise<SqlJsStatic>;
  export default initSqlJs;
  export type { Database, Statement, SqlJsStatic };
}
