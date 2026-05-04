import express, { Application, Request, Response } from "express";

const app: Application = express();
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.get("/", (req: Request, res: Response) => {
  res.send("Hello, World!");
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
});
