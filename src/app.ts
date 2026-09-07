import cors from 'cors';
import express from "express";
import authRoutes from "./routes/auth.routes.js";
import householdRoutes from "./routes/household.routes.js";

const app = express();

// Allow the local Expo web preview; native apps do not require CORS.
const webOrigins = (process.env["WEB_ORIGINS"] || "http://localhost:8081,http://localhost:8082").split(",").map((origin) => origin.trim());
app.use(cors({ origin: webOrigins }));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/households", householdRoutes);

export default app;

