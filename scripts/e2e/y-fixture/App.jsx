import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function Greeting({ name }) {
  return <h1 id="greet">Hello {name}</h1>;
}

function Counter() {
  const [n, setN] = useState(0);
  return (
    <div id="box">
      <button id="inc" onClick={() => setN(n + 1)}>count {n}</button>
    </div>
  );
}

export default function App() {
  return (
    <main>
      <Greeting name="IDE" />
      <Counter />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
