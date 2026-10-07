import { describe, expect, it } from "vitest";
import { findComponents, isComponentFile, suggestProps, unsuggested } from "./components";

const names = (src: string, path = "src/Thing.jsx") => findComponents(path, src).map((c) => `${c.exportName}:${c.name}`);

describe("findComponents", () => {
  it("finds a default function with destructured props and defaults", () => {
    const [c] = findComponents("src/components/Greeting.jsx", `import React from "react";
export default function Greeting({ name = "World", count = 3, onClick, isOpen, items }) {
  return <div onClick={onClick}>{name}</div>;
}`);
    expect(c).toMatchObject({ name: "Greeting", exportName: "default", kind: "function", line: 2 });
    expect(c.props.map((p) => [p.name, p.type])).toEqual([["name", "string"], ["count", "number"], ["onClick", "function"], ["isOpen", "boolean"], ["items", "array"]]);
    expect(suggestProps(c)).toEqual({ name: "World", count: 3, onClick: { $fn: "onClick" }, isOpen: false, items: [] });
  });

  it("finds named arrows, wrapped components, classes and export lists, and skips constants and helpers", () => {
    const src = `import React, { memo, forwardRef } from "react";
export const Card = ({ title }) => <section>{title}</section>;
export const Fancy = React.memo(function Fancy(props) { return <i>{props.tone}</i>; });
export const Input2 = forwardRef((p, ref) => <input ref={ref} />);
export const API_URL = "x";
export const helper = () => 1;
export class Panel extends React.PureComponent { render() { return <div>{this.props.heading}</div>; } }
function Hidden() { return <b />; }
export { Hidden, Hidden as Alias };`;
    expect(names(src)).toEqual(["Card:Card", "Fancy:Fancy", "Input2:Input2", "Panel:Panel", "Hidden:Hidden", "Alias:Hidden"]);
    const panel = findComponents("a.jsx", src).find((c) => c.name === "Panel")!;
    expect(panel.props.map((p) => p.name)).toEqual(["heading"]);
  });

  it("recognises HOC and memo default exports by their inner name", () => {
    expect(names(`function List(){ return <ul/>; }\nexport default connect(mapState)(List);`)).toEqual(["default:List"]);
    expect(names(`const Row = () => <tr/>;\nexport default memo(Row);`)).toEqual(["default:Row"]);
    expect(names(`function Page(){ return <div/>; }\nexport default Page;`)).toEqual(["default:Page"]);
  });

  it("names an anonymous default export after the file", () => {
    expect(names(`export default () => <div/>;`, "src/pages/order-list.jsx")).toEqual(["default:Order-list".replace("-", "")]);
    expect(names(`export default function () { return <div/>; }`, "src/pages/index.js")).toEqual(["default:Component"]);
  });

  it("ignores commented-out exports, non-JSX files and test files", () => {
    expect(names(`// export default function A(){ return <a/>; }\n/* export const B = () => <b/>; */`)).toEqual([]);
    expect(names(`export const Util = () => 42;`)).toEqual([]);
    expect(findComponents("src/a.test.jsx", `export default () => <div/>;`)).toEqual([]);
    expect(findComponents("src/data.json", `export default () => <div/>;`)).toEqual([]);
  });

  it("reads PropTypes and TypeScript props", () => {
    const [pt] = findComponents("a.jsx", `export default function A(props) { return <div>{props.title}</div>; }
A.propTypes = { title: PropTypes.string.isRequired, rows: PropTypes.arrayOf(PropTypes.object), onSave: PropTypes.func };`);
    expect(pt.props.map((p) => [p.name, p.type, p.required])).toEqual([["title", "string", true], ["rows", "array", false], ["onSave", "function", false]]);
    const [ts] = findComponents("a.tsx", `interface ButtonProps { label: string; size?: number; onPress: () => void; icon?: React.ReactNode }
export default function Button({ label, size, onPress, icon }: ButtonProps) { return <button>{label}</button>; }`);
    expect(ts.props.map((p) => [p.name, p.type])).toEqual([["label", "string"], ["size", "number"], ["onPress", "function"], ["icon", "node"]]);
  });

  it("lists props it could not give a value", () => {
    const [c] = findComponents("a.jsx", `export default function A({ foo, label }) { return <div/>; }`);
    expect(suggestProps(c)).toEqual({ label: "Label" });
    expect(unsuggested(c)).toEqual(["foo"]);
  });

  it("is bounded: a huge file is not scanned", () => {
    expect(findComponents("a.jsx", `export default () => <a/>;${" ".repeat(400_001)}`)).toEqual([]);
  });
});

describe("isComponentFile", () => {
  it("accepts source files outside node_modules, tests, stories and type declarations", () => {
    for (const ok of ["a.jsx", "src/a.tsx", "src/a.js", "x/y.mjs"]) expect(isComponentFile(ok)).toBe(true);
    for (const no of ["a.json", "a.css", "node_modules/x/a.js", "a.test.js", "a.spec.tsx", "a.stories.jsx", "a.d.ts", "a.md"]) expect(isComponentFile(no)).toBe(false);
  });
});
