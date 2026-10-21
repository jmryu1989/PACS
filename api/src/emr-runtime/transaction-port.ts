import { Prisma, type PrismaClient } from '@prisma/client';

const operations = ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate',
  'groupBy', 'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const;
type Operation = typeof operations[number];
type ModelKey = Uncapitalize<Prisma.ModelName>;
type Delegate<D> = { readonly [O in Extract<Operation, keyof D>]: <A extends Prisma.Args<D, O>>(
  ...args: {} extends Prisma.Args<D, O> ? [args?: Prisma.Exact<A, Prisma.Args<D, O>>] : [args: Prisma.Exact<A, Prisma.Args<D, O>>]
) => Promise<Prisma.Result<D, A, O>> };

/** A data-query capability, deliberately without Prisma's fluent delegates or lazy promises. */
export type EmrRecordTransaction = { readonly [M in ModelKey]: Delegate<PrismaClient[M]> };

/** raw and the operation runner stay in closures owned by one work; neither is put on a consumer object. */
export function createTransactionProjection(raw: Prisma.TransactionClient,
  runModelOperation: <T>(operation: () => PromiseLike<T>) => Promise<T>): EmrRecordTransaction {
  const projection = Object.create(null);
  for (const model of Object.values(Prisma.ModelName)) {
    const key = model[0].toLowerCase() + model.slice(1);
    const rawDelegate = raw[key];
    const delegate = Object.create(null);
    for (const operation of operations) {
      if (typeof rawDelegate?.[operation] !== 'function') continue;
      delegate[operation] = (args: unknown) => runModelOperation(() => rawDelegate[operation](args));
    }
    projection[key] = Object.freeze(delegate);
  }
  return Object.freeze(projection);
}
