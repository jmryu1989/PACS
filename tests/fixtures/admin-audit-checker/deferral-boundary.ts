import { Prisma } from '@prisma/client';

export function unreviewed(tx: Prisma.TransactionClient, fragment: Prisma.Sql) {
  // expect: unresolved F02 takes only values
  return tx.$queryRaw`SELECT 1 ${fragment}`;
}
