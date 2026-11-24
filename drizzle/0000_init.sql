CREATE TABLE "outbox" (
	"id_evento" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" varchar(50) NOT NULL,
	"datos" jsonb NOT NULL,
	"fecha_cambio" timestamp with time zone DEFAULT now() NOT NULL,
	"fecha_envio" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "persona" (
	"id_persona" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id_usuario" uuid NOT NULL,
	"nombre" varchar(120) NOT NULL,
	"telefono" varchar(10) NOT NULL,
	"foto_perfil_url" varchar(255),
	"descripcion" varchar(500),
	"fecha_nacimiento" date NOT NULL,
	CONSTRAINT "persona_id_usuario_unique" UNIQUE("id_usuario"),
	CONSTRAINT "persona_telefono_ck" CHECK ("persona"."telefono" ~ '^09[0-9]{8}$')
);
--> statement-breakpoint
CREATE TABLE "refugio" (
	"id_refugio" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id_usuario" uuid NOT NULL,
	"nombre_institucion" varchar(120) NOT NULL,
	"ubicacion" varchar(255) NOT NULL,
	"telefono" varchar(10) NOT NULL,
	"foto_perfil_url" varchar(255),
	"descripcion" varchar(500),
	"fecha_creacion" date,
	"pagina_web" varchar(255),
	CONSTRAINT "refugio_id_usuario_unique" UNIQUE("id_usuario"),
	CONSTRAINT "refugio_telefono_ck" CHECK ("refugio"."telefono" ~ '^09[0-9]{8}$'),
	CONSTRAINT "refugio_pagina_web_ck" CHECK ("refugio"."pagina_web" IS NULL OR "refugio"."pagina_web" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "rol" (
	"id_rol" smallint PRIMARY KEY NOT NULL,
	"codigo" varchar(20) NOT NULL,
	"nombre" varchar(50) NOT NULL,
	CONSTRAINT "rol_codigo_unique" UNIQUE("codigo")
);
--> statement-breakpoint
CREATE TABLE "usuario" (
	"id_usuario" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correo" varchar(120) NOT NULL,
	"contrasena_hash" varchar(255),
	"correo_confirmado" boolean DEFAULT false NOT NULL,
	"eliminado" boolean DEFAULT false NOT NULL,
	"fecha_eliminacion" timestamp with time zone,
	"fecha_registro" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuario_rol" (
	"id_usuario" uuid NOT NULL,
	"id_rol" smallint NOT NULL,
	"fecha_asignacion" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuario_rol_id_usuario_id_rol_pk" PRIMARY KEY("id_usuario","id_rol"),
	CONSTRAINT "usuario_rol_usuario_uk" UNIQUE("id_usuario")
);
--> statement-breakpoint
ALTER TABLE "persona" ADD CONSTRAINT "persona_id_usuario_usuario_id_usuario_fk" FOREIGN KEY ("id_usuario") REFERENCES "public"."usuario"("id_usuario") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refugio" ADD CONSTRAINT "refugio_id_usuario_usuario_id_usuario_fk" FOREIGN KEY ("id_usuario") REFERENCES "public"."usuario"("id_usuario") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuario_rol" ADD CONSTRAINT "usuario_rol_id_usuario_usuario_id_usuario_fk" FOREIGN KEY ("id_usuario") REFERENCES "public"."usuario"("id_usuario") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuario_rol" ADD CONSTRAINT "usuario_rol_id_rol_rol_id_rol_fk" FOREIGN KEY ("id_rol") REFERENCES "public"."rol"("id_rol") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_pendientes_idx" ON "outbox" USING btree ("fecha_cambio") WHERE "outbox"."fecha_envio" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "usuario_correo_uk" ON "usuario" USING btree (lower("correo"));--> statement-breakpoint
CREATE INDEX "usuario_rol_rol_idx" ON "usuario_rol" USING btree ("id_rol");