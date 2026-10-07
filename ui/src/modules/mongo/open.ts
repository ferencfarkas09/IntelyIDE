import type { ProfileView } from "../../ipc/mongo";
import { openCollectionTab, type CollectionTabParams } from "./gate";
import { isDangerous } from "./logic";

export const dangerousParams = (p: ProfileView, db: string, collection: string): CollectionTabParams => ({
  connectionId: p.id,
  connectionName: p.name,
  db,
  collection,
  environment: p.environment,
  dangerous: isDangerous(p),
});

export function openCollection(p: ProfileView, db: string, collection: string): string {
  return openCollectionTab(dangerousParams(p, db, collection));
}
