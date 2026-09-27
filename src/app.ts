import cors from 'cors';
import express from "express";
import authRoutes from "./routes/auth.routes.js";
import householdRoutes from "./routes/household.routes.js";
import userRoutes from "./routes/user.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import invitationRoutes from "./routes/invitation.routes.js";
import { conversationRoutes, deviceRoutes, householdChatRoutes } from "./routes/chat.routes.js";
import { webOrigins } from "./lib/web-origins.js";

const app = express();

// Allow the local Expo web preview; native apps do not require CORS.
app.use(cors({ origin: webOrigins }));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/households", householdRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/invitations", invitationRoutes);
app.use("/api/households/:householdId/conversations", householdChatRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/devices", deviceRoutes);

export default app;

