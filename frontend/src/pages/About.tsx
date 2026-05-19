import { Link } from "react-router-dom";

export default function About() {
    return (
        <div className="p-8">
            <h1 className="text-3xl font-bold">About</h1>
            <Link to="/" className="text-blue-600 underline">
                Home
            </Link>
        </div>
    );
}
