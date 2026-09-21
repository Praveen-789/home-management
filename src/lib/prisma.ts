import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

const schema = process.env["DATABASE_SCHEMA"] || "public";
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("Invalid DATABASE_SCHEMA");
const adapter = new PrismaPg({
  connectionString: process.env["DATABASE_URL"]!,
  options: `-c search_path=${schema}`,
}, { schema });

const prisma = new PrismaClient({
  adapter,
});

export default prisma;
