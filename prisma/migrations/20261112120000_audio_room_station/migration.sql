-- Station for Prayer Watch and channel calls. Nullable so existing rooms stay valid.
-- Deploy applies this before the code that reads the columns. Do not run it by hand against production.
ALTER TABLE "AudioRoom" ADD COLUMN "playbackUrl" TEXT;
ALTER TABLE "AudioRoom" ADD COLUMN "bunnyStreamId" TEXT;
ALTER TABLE "AudioRoom" ADD COLUMN "agoraConverterId" TEXT;
ALTER TABLE "AudioRoom" ADD COLUMN "stationStartedAt" TIMESTAMP(3);
