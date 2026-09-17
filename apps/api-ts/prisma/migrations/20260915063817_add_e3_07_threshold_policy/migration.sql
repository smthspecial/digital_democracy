-- AlterTable
ALTER TABLE "jurisdiction" ADD COLUMN     "max_threshold" INTEGER,
ADD COLUMN     "min_threshold" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "population" INTEGER,
ADD COLUMN     "support_rate_bps" INTEGER NOT NULL DEFAULT 500;
