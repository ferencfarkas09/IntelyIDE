import { markOf } from "./catalog";
import "./providerMark.css";

/** A provider's identity in a header or a list: two letters on a tile, tinted per provider through `data-provider`. */
export function ProviderMark(props: { id: string; size?: number; class?: string }) {
  const size = () => props.size ?? 18;
  return (
    <span class={props.class ? `pmark ${props.class}` : "pmark"} data-provider={props.id} style={{ "--pmark-size": `${size()}px` }} aria-hidden="true">
      {markOf(props.id)}
    </span>
  );
}
