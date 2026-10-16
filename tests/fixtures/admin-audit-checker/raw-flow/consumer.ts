// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the owning service side of the raw
// flow fixture (producer.ts). A factory of another module returning the port's interface, and a service whose response
// context carries its transaction client, its root client and the access service it was given. `// expect:` and
// `@rf:<tag>` as in producer.ts.
import { Prisma } from '@prisma/client';
import { SynFlowAccess, SynFlowCaller, SynFlowPrisma, synFlowBind, synFlowMake, synFlowPort } from './producer';

/** Object.freeze typed as the value it keeps (the shape of the contract's own freeze). */
export function synFreeze<T>(value: T): Readonly<T> { return Object.freeze(value); }

/** A factory of another module returning the interface (RF-P), called at start. */
export function synFlowCompose(db: SynFlowPrisma) { synFlowBind(synFlowMake(db)); } // @rf:compose

/** An owning service: its context carries both clients and the access service it holds (W4). */
export class SynFlowService {
  constructor(private readonly prisma: SynFlowPrisma, private readonly access: SynFlowAccess) {}
  async read(request: unknown, c: SynFlowCaller) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.access.snapshot(c, tx); // @rf:snapshot
      const port = synFlowPort();
      return port.respond(request, { db: this.prisma, tx, caller: c, access: this.access }); // @rf:carrier
    });
  }
  async refuse(request: unknown, code: string) { return synFlowPort().refuse(request, code); }
}
// end of consumer.ts
