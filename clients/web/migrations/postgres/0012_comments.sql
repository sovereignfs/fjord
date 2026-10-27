CREATE TABLE "fjord"."comment_activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."comment_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"doc_id" text NOT NULL,
	"thread_id" bigint,
	"actor_kind" text NOT NULL,
	"actor_name" text NOT NULL,
	"event" text NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fjord"."comment_closed" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."comment_closed_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"doc_id" text NOT NULL,
	"closed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fjord"."comment_reply" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."comment_reply_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" bigint NOT NULL,
	"connection_id" bigint NOT NULL,
	"doc_id" text NOT NULL,
	"body" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"edited_at" bigint
);
--> statement-breakpoint
CREATE TABLE "fjord"."comment_thread" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."comment_thread_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"doc_id" text NOT NULL,
	"anchor" text NOT NULL,
	"body" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"edited_at" bigint,
	"resolved_at" bigint,
	"resolved_by" text
);
--> statement-breakpoint
CREATE INDEX "comment_activity_document_idx" ON "fjord"."comment_activity" USING btree ("connection_id","doc_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_closed_document_idx" ON "fjord"."comment_closed" USING btree ("connection_id","doc_id");--> statement-breakpoint
CREATE INDEX "comment_reply_thread_idx" ON "fjord"."comment_reply" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "comment_reply_document_idx" ON "fjord"."comment_reply" USING btree ("connection_id","doc_id");--> statement-breakpoint
CREATE INDEX "comment_thread_document_idx" ON "fjord"."comment_thread" USING btree ("connection_id","doc_id");