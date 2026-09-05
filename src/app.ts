import express from "express";
import authRoutes from "./routes/auth.routes.js";
import householdRoutes from "./routes/household.routes.js";

const app = express();

app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/households", householdRoutes);

export default app;
