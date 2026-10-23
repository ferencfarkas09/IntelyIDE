import { cleanup, render, screen } from "@solidjs/testing-library";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { lazy } from "./lazy";

afterEach(cleanup);

const Badge = (props: { name: string }) => <i data-testid="badge">badge {props.name}</i>;
const host = (node: () => unknown) => render(() => <Suspense fallback={<b data-testid="spinner">loading</b>}>{node() as never}</Suspense>);

describe("lazy", () => {
  it("suspends for the first load only", async () => {
    const Lazy = lazy(() => Promise.resolve({ default: Badge }));
    const first = host(() => <Lazy name="a" />);
    expect(screen.queryByTestId("spinner")).not.toBeNull();
    expect((await screen.findByTestId("badge")).textContent).toBe("badge a");
    first.unmount();

    // The instance that loaded it is gone (a virtual row that scrolled out). The next one must not suspend again: a spinner here would
    // swap the whole panel around the list for its fallback, and the panel would come back scrolled to the top.
    host(() => <Lazy name="b" />);
    expect(screen.queryByTestId("spinner")).toBeNull();
    expect(screen.getByTestId("badge").textContent).toBe("badge b");
  });

  it("loads the module once for every instance", async () => {
    let loads = 0;
    const Lazy = lazy(() => (loads++, Promise.resolve({ default: Badge })));
    host(() => (
      <>
        <Lazy name="a" />
        <Lazy name="b" />
      </>
    ));
    await screen.findAllByTestId("badge");
    host(() => <Lazy name="c" />);
    expect(loads).toBe(1);
  });
});
