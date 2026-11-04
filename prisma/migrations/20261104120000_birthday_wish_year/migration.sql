-- The year we last sent a birthday wish, so the morning job does not send twice.
ALTER TABLE "User" ADD COLUMN "lastBirthdayWishYear" INTEGER;
