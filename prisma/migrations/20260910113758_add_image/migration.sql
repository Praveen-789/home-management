-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "taskId" TEXT,
    "expenseId" TEXT,
    "publicId" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Image_publicId_key" ON "Image"("publicId");

-- CreateIndex
CREATE INDEX "Image_taskId_idx" ON "Image"("taskId");

-- CreateIndex
CREATE INDEX "Image_expenseId_idx" ON "Image"("expenseId");

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Image" ADD CONSTRAINT "Image_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An image belongs to exactly one parent: a task or an expense, never both and never neither.
ALTER TABLE "Image" ADD CONSTRAINT "Image_single_parent_check" CHECK (("taskId" IS NOT NULL)::int + ("expenseId" IS NOT NULL)::int = 1);
