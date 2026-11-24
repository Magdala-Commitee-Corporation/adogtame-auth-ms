import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { type CrearUsuario, crearUsuario } from "../src/users.js";
import { ADMIN_KEY, createTestApp, persona } from "./helpers.js";

const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("roles", () => {
  test("lists the four fixed roles", async () => {
    const { call } = await createTestApp();
    const res = await call("GET", "/roles");
    assert.equal(res.status, 200);
    assert.deepEqual(
      ((await res.json()) as { codigo: string }[]).map((r) => r.codigo),
      ["MIEMBRO", "RESCATISTA", "REFUGIO", "ADMINISTRADOR"],
    );
  });
});

describe("users: create", () => {
  test("creates a member with role and person profile in one go", async () => {
    const { call } = await createTestApp();
    const res = await call("POST", "/users", { correo: "Ana@Example.com ", rol: "MIEMBRO", persona: persona() });
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.equal(body.correo, "ana@example.com");
    assert.equal(body.rol.codigo, "MIEMBRO");
    assert.equal(body.perfil.tipo, "persona");
    assert.equal(body.perfil.nombre, "Ana Pérez");
    assert.equal(body.correoConfirmado, false);
    assert.equal("contrasenaHash" in body, false);
  });

  test("creates a shelter with an institutional profile", async () => {
    const { call } = await createTestApp();
    const res = await call("POST", "/users", {
      correo: "refugio@example.com",
      rol: "REFUGIO",
      refugio: { nombreInstitucion: "Huellitas", ubicacion: "Quito", telefono: "0987654321", paginaWeb: "https://huellitas.ec" },
    });
    assert.equal(res.status, 201);
    assert.equal((await json(res)).perfil.tipo, "refugio");
  });

  test("rejects a duplicated email, ignoring case", async () => {
    const { call } = await createTestApp();
    await call("POST", "/users", { correo: "ana@example.com", rol: "MIEMBRO", persona: persona() });
    const res = await call("POST", "/users", { correo: "ANA@example.com", rol: "MIEMBRO", persona: persona() });
    assert.equal(res.status, 409);
    assert.equal((await json(res)).codigo, "CORREO_EN_USO");
  });

  test("validates phone, age and profile type", async () => {
    const { call } = await createTestApp();
    const cases = [
      { correo: "a@example.com", rol: "MIEMBRO", persona: persona({ telefono: "12345" }) },
      { correo: "b@example.com", rol: "MIEMBRO", persona: persona({ fechaNacimiento: "2015-01-01" }) },
      { correo: "c@example.com", rol: "REFUGIO", persona: persona() },
      { correo: "no-es-correo", rol: "MIEMBRO", persona: persona() },
    ];
    for (const body of cases) {
      const res = await call("POST", "/users", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await json(res)).codigo, "VALIDACION");
    }
  });

  test("leaves nothing behind when the profile insert fails", async () => {
    const { call, db } = await createTestApp();
    // Skips validation on purpose so PostgreSQL rejects the profile (CHECK on the phone)
    // after the user row was inserted: the transaction must roll back both.
    await assert.rejects(
      crearUsuario(db, { correo: "x@example.com", rol: "MIEMBRO", persona: persona({ telefono: "1234567890" }) } as CrearUsuario),
    );
    const list = await json(await call("GET", "/users?incluirEliminados=true"));
    assert.equal(list.length, 0);
  });
});

describe("users: read and edit", () => {
  test("gets, filters and edits a user; the same 404 for unknown or malformed ids", async () => {
    const { call } = await createTestApp();
    const ana = await json(await call("POST", "/users", { correo: "ana@example.com", rol: "MIEMBRO", persona: persona() }));
    await call("POST", "/users", { correo: "admin@example.com", rol: "ADMINISTRADOR", persona: persona({ nombre: "Admin" }) });

    assert.equal((await json(await call("GET", `/users/${ana.idUsuario}`))).correo, "ana@example.com");
    assert.equal((await json(await call("GET", "/users?rol=ADMINISTRADOR"))).length, 1);
    assert.equal((await json(await call("GET", "/users?q=pérez"))).length, 1);

    const edited = await json(await call("PATCH", `/users/${ana.idUsuario}`, { persona: { telefono: "0987654321" } }));
    assert.equal(edited.perfil.telefono, "0987654321");
    assert.equal(edited.perfil.nombre, "Ana Pérez");

    const notAllowed = await call("PATCH", `/users/${ana.idUsuario}`, { correo: "otro@example.com" });
    assert.equal(notAllowed.status, 400);

    for (const id of ["00000000-0000-4000-8000-000000000000", "123"]) {
      const res = await call("GET", `/users/${id}`);
      assert.equal(res.status, 404);
      assert.equal((await json(res)).codigo, "NO_ENCONTRADO");
    }
  });
});

describe("users: delete and restore", () => {
  test("logical delete publishes CuentaEliminada and hides the user from the default list", async () => {
    const { call, published } = await createTestApp();
    const ana = await json(await call("POST", "/users", { correo: "ana@example.com", rol: "MIEMBRO", persona: persona() }));

    const res = await call("DELETE", `/users/${ana.idUsuario}`);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).eliminado, true);
    assert.equal((await json(await call("GET", "/users"))).length, 0);
    assert.deepEqual(
      published.map((e) => [e.tipo, (e.datos as { idUsuario: string }).idUsuario]),
      [["CuentaEliminada", ana.idUsuario]],
    );

    // The email is not released after deletion (RN-07).
    const again = await call("POST", "/users", { correo: "ana@example.com", rol: "MIEMBRO", persona: persona() });
    assert.equal(again.status, 409);

    const restored = await json(await call("POST", `/users/${ana.idUsuario}/restore`));
    assert.equal(restored.eliminado, false);
    assert.equal(published.at(-1)?.tipo, "CuentaRestaurada");
  });

  test("never deletes the last active administrator (RN-11)", async () => {
    const { call } = await createTestApp();
    const a1 = await json(await call("POST", "/users", { correo: "a1@example.com", rol: "ADMINISTRADOR", persona: persona() }));
    const a2 = await json(await call("POST", "/users", { correo: "a2@example.com", rol: "ADMINISTRADOR", persona: persona() }));
    assert.equal((await call("DELETE", `/users/${a1.idUsuario}`)).status, 200);
    const res = await call("DELETE", `/users/${a2.idUsuario}`);
    assert.equal(res.status, 409);
    assert.equal((await json(res)).codigo, "ULTIMO_ADMINISTRADOR");
  });

  test("an event that failed to publish is sent by the next request", async () => {
    const { call, published, setFailPublish } = await createTestApp();
    const ana = await json(await call("POST", "/users", { correo: "ana@example.com", rol: "MIEMBRO", persona: persona() }));
    setFailPublish(true);
    assert.equal((await call("DELETE", `/users/${ana.idUsuario}`)).status, 200);
    assert.equal(published.length, 0);

    setFailPublish(false);
    await call("GET", "/roles");
    assert.deepEqual(published.map((e) => e.tipo), ["CuentaEliminada"]);
  });
});

describe("guards", () => {
  test("administration routes require the admin key", async () => {
    const { call } = await createTestApp();
    for (const headers of [{}, { "x-admin-key": "wrong" }] as Record<string, string>[]) {
      const res = await call("GET", "/users", undefined, headers);
      assert.equal(res.status, 403);
      assert.equal((await json(res)).codigo, "PROHIBIDO");
    }
  });

  test("without a database the service answers DEPENDENCIA_NO_DISPONIBLE", async () => {
    const app = createApp({ adminKey: ADMIN_KEY });
    const res = await app.request("/users", { headers: { "x-admin-key": ADMIN_KEY } });
    assert.equal(res.status, 503);
    assert.equal((await json(res)).codigo, "DEPENDENCIA_NO_DISPONIBLE");
    assert.equal((await app.request("/health")).status, 200);
  });
});
