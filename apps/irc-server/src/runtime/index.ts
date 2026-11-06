import type { AppContext } from '../context.js';
import { createAuditService } from '../modules/audit/service.js';
import { createFilterService } from '../modules/filters/service.js';
import { createGroupService } from '../modules/groups/service.js';
import type { AuditService, FilterService, GroupService, MessageDispatcher } from './contracts.js';
import { DedupeStore } from './dedupe.js';
import { Dispatcher } from './dispatcher.js';
import { createPresenceStore, type PresenceStore } from './presence.js';
import { InMemoryRegistry } from './registry.js';

/** Everything the HTTP and WebSocket layers share, built once at boot. */
export interface Runtime {
  registry: InMemoryRegistry;
  presence: PresenceStore;
  dispatcher: MessageDispatcher;
  dedupe: DedupeStore;
  groups: GroupService;
  filters: FilterService;
  audit: AuditService;
}

export function createRuntime(ctx: AppContext): Runtime {
  const registry = new InMemoryRegistry();
  return {
    registry,
    presence: createPresenceStore(ctx),
    dispatcher: new Dispatcher(registry),
    dedupe: new DedupeStore(ctx.redis, ctx.config.dedupeTtlMs),
    groups: createGroupService(ctx),
    filters: createFilterService(ctx),
    audit: createAuditService(ctx),
  };
}
