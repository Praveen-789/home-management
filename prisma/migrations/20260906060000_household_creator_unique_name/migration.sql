BEGIN;

-- Lock existing data while inferring creators and installing the constraint.
LOCK TABLE "Household", "HouseholdMember" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT h.id FROM "Household" h
        LEFT JOIN "HouseholdMember" m ON m."householdId" = h.id AND m.role = 'OWNER'
        GROUP BY h.id HAVING count(m.id) <> 1
    ) THEN
        RAISE EXCEPTION 'Each existing household must have exactly one OWNER to backfill its creator';
    END IF;
    IF EXISTS (
        SELECT m."userId", h.name FROM "Household" h
        JOIN "HouseholdMember" m ON m."householdId" = h.id AND m.role = 'OWNER'
        GROUP BY m."userId", h.name HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Resolve duplicate household names for the same owner before applying this migration';
    END IF;
END $$;

ALTER TABLE "Household" ADD COLUMN "createdById" TEXT;
UPDATE "Household" h SET "createdById" = m."userId"
FROM "HouseholdMember" m WHERE m."householdId" = h.id AND m.role = 'OWNER';
ALTER TABLE "Household" ALTER COLUMN "createdById" SET NOT NULL;
CREATE UNIQUE INDEX "Household_createdById_name_key" ON "Household"("createdById", "name");
ALTER TABLE "Household" ADD CONSTRAINT "Household_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
