import "dotenv/config";
export const webOrigins = (process.env["WEB_ORIGINS"] || "http://localhost:8081,http://localhost:8082")
  .split(",").map(origin => origin.trim());
