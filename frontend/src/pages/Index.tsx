import { useState } from "react";

export default function Index() {
    const [count, setCount] = useState(0);

    return (
        <>
            <section id="center">
                <div>
                    <h1>Get started</h1>
                    <p>
                        Edit <code>src/App.tsx</code> and save to test{" "}
                        <code>HMR</code>
                    </p>
                </div>
                <button
                    type="button"
                    className="counter"
                    onClick={() => setCount((count) => count + 1)}
                >
                    Count is {count}
                </button>
            </section>
        </>
    );
}
