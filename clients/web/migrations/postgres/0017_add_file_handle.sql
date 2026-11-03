CREATE TABLE "fjord"."file_handle" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."file_handle_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"path" text NOT NULL,
	"handle" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "file_handle_connection_path_idx" ON "fjord"."file_handle" USING btree ("connection_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "file_handle_handle_idx" ON "fjord"."file_handle" USING btree ("handle");