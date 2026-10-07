import type { ScalarView } from "../../ui-kit/JsonTree";
import { isScalarObject, scalarText, typeOf, type Json } from "./ejson";

/** Tells the JsonTree that an Extended JSON wrapper (ObjectId, Date, NumberLong...) is one value, not a sub-document. */
export function scalarView(v: object): ScalarView | undefined {
  if (!isScalarObject(v)) return undefined;
  return { text: scalarText(v as Json), type: typeOf(v as Json) };
}
