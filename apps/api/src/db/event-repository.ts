import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { githubEvents, type GithubEventSummary, type SupportedGithubEventName } from "./schema.js";

export interface NewGithubEvent {
  deliveryId: string;
  eventName: SupportedGithubEventName;
  action: string | null;
  repositoryId: string;
  repositoryFullName: string;
  occurredAt: Date | null;
  commitSha: string | null;
  summary: GithubEventSummary;
}

export interface GithubEventRepository {
  /** Returns true only when this delivery is newly persisted. */
  saveOnce(event: NewGithubEvent): Promise<boolean>;
}

export class DrizzleGithubEventRepository implements GithubEventRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async saveOnce(event: NewGithubEvent): Promise<boolean> {
    const inserted = await this.db
      .insert(githubEvents)
      .values(event)
      .onConflictDoNothing({ target: githubEvents.deliveryId })
      .returning({ id: githubEvents.id });

    return inserted.length === 1;
  }
}

/** Read-only lookup useful for later incident correlation and diagnostics. */
export async function findEventByDeliveryId(
  db: NodePgDatabase<typeof schema>,
  deliveryId: string
) {
  const rows = await db.select().from(githubEvents).where(eq(githubEvents.deliveryId, deliveryId)).limit(1);
  return rows[0] ?? null;
}
