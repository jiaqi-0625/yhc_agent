export interface PostgresQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}
export interface PostgresQueryable {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresTransactionProvider extends PostgresQueryable {
  transaction<Result>(
    operation: (transaction: PostgresQueryable) => Promise<Result>,
  ): Promise<Result>;
}
