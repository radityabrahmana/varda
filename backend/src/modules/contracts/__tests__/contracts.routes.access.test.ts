import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level privacy: every /contracts/:id route resolves the caller's access
// first (404 when they may not see the review) and checks the capability the
// route needs before calling into the service.

const svc = vi.hoisted(() => ({
  resolveReviewAccess: vi.fn(),
  listReviews: vi.fn(),
  getReviewDetail: vi.fn(),
  getReviewStatus: vi.fn(),
  createFeedback: vi.fn(),
  updateReviewMeta: vi.fn(),
  deleteReview: vi.fn(),
  listReviewPeople: vi.fn(),
  listReviewGrants: vi.fn(),
  grantReviewAccess: vi.fn(),
  revokeReviewAccess: vi.fn(),
  createSuggestion: vi.fn(),
  resolveSuggestion: vi.fn(),
  listTrackedChangeIds: vi.fn(),
}));

vi.mock("../../../middleware/auth", () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.userId = req.get("x-test-user") ?? "u-member";
    res.locals.userEmail = req.get("x-test-email") ?? "member@dashelectric.co";
    next();
  },
}));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../contracts.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contracts.service")>()),
  ...svc,
}));

import { contractsRouter } from "../contracts.routes";

const app = express();
app.use(express.json());
app.use("/contracts", contractsRouter);

const REVIEW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const asRole = (role: "owner" | "editor" | "viewer", via: "creator" | "grant" | "admin" = "grant") =>
  svc.resolveReviewAccess.mockResolvedValue({ ok: true, data: { reviewId: REVIEW, ownerId: "u-owner", role, via } });

beforeEach(() => {
  vi.clearAllMocks();
  svc.getReviewDetail.mockResolvedValue({ ok: true, data: { review: { id: REVIEW }, feedback: [] } });
  svc.getReviewStatus.mockResolvedValue({ ok: true, data: { id: REVIEW, status: "ai_reviewed" } });
  svc.createFeedback.mockResolvedValue({ ok: true, data: { id: "f1" } });
  svc.updateReviewMeta.mockResolvedValue({ ok: true, data: { id: REVIEW } });
  svc.deleteReview.mockResolvedValue({ ok: true, data: null });
  svc.listReviewPeople.mockResolvedValue({ ok: true, data: { scope: "direct", owner: null, members: [] } });
  svc.listReviewGrants.mockResolvedValue({ ok: true, data: [] });
  svc.grantReviewAccess.mockResolvedValue({ ok: true, data: { email: "d@dashelectric.co", role: "viewer" } });
  svc.revokeReviewAccess.mockResolvedValue({ ok: true, data: null });
  svc.createSuggestion.mockResolvedValue({ ok: true, data: { id: "s1" } });
  svc.resolveSuggestion.mockResolvedValue({ ok: true, data: { id: "s1", status: "accepted" } });
  svc.listTrackedChangeIds.mockResolvedValue({ ok: true, data: { ids: [] } });
});

const suggestion = { selected_text: "30 hari", replacement: "14 hari", context_before: "", context_after: "" };

const feedback = { finding_type: "red_flag", finding_id: "RF-001", action: "valid" };

describe("contracts routes — privacy", () => {
  it("passes the caller to the list so it can scope by owner, grants and admin", async () => {
    svc.listReviews.mockResolvedValue({ ok: true, data: [] });
    await request(app).get("/contracts").set("x-test-user", "u1").set("x-test-email", "a@dashelectric.co").expect(200);
    expect(svc.listReviews).toHaveBeenCalledWith(expect.anything(), { userId: "u1", email: "a@dashelectric.co" });
  });

  it("answers 404 on every review route when the caller has no access, without calling the handler", async () => {
    svc.resolveReviewAccess.mockResolvedValue({ ok: false, kind: "not_found", detail: "Tinjauan tidak ditemukan." });
    await request(app).get(`/contracts/${REVIEW}`).expect(404);
    await request(app).get(`/contracts/${REVIEW}/status`).expect(404);
    await request(app).get(`/contracts/${REVIEW}/file`).expect(404);
    await request(app).get(`/contracts/${REVIEW}/people`).expect(404);
    await request(app).get(`/contracts/${REVIEW}/tracked-change-ids`).expect(404);
    await request(app).post(`/contracts/${REVIEW}/suggestions`).send(suggestion).expect(404);
    await request(app).post(`/contracts/${REVIEW}/feedback`).send(feedback).expect(404);
    await request(app).post(`/contracts/${REVIEW}/access`).send({ email: "x@dashelectric.co", role: "viewer" }).expect(404);
    await request(app).delete(`/contracts/${REVIEW}`).expect(404);
    expect(svc.getReviewDetail).not.toHaveBeenCalled();
    expect(svc.createFeedback).not.toHaveBeenCalled();
    expect(svc.grantReviewAccess).not.toHaveBeenCalled();
    expect(svc.deleteReview).not.toHaveBeenCalled();
    expect(svc.resolveReviewAccess).toHaveBeenCalledWith(expect.anything(), {
      reviewId: REVIEW,
      userId: "u-member",
      email: "member@dashelectric.co",
    });
  });

  it("lets a viewer read (with their role in the payload) but refuses edits, sharing and delete", async () => {
    asRole("viewer");
    const detail = await request(app).get(`/contracts/${REVIEW}`).expect(200);
    expect(detail.body.access).toEqual({ role: "viewer", via: "grant" });
    await request(app).get(`/contracts/${REVIEW}/status`).expect(200);
    await request(app).get(`/contracts/${REVIEW}/people`).expect(200);

    await request(app).post(`/contracts/${REVIEW}/feedback`).send(feedback).expect(403);
    await request(app).patch(`/contracts/${REVIEW}`).send({ status: "clevel_reviewed" }).expect(403);
    await request(app).post(`/contracts/${REVIEW}/memo`).expect(403);
    await request(app).post(`/contracts/${REVIEW}/comments`).send({}).expect(403);
    await request(app).post(`/contracts/${REVIEW}/revisions/REV-001/accept`).expect(403);
    await request(app).get(`/contracts/${REVIEW}/access`).expect(403);
    await request(app).post(`/contracts/${REVIEW}/access`).send({ email: "x@dashelectric.co", role: "viewer" }).expect(403);
    await request(app).delete(`/contracts/${REVIEW}`).expect(403);
    await request(app).post(`/contracts/${REVIEW}/suggestions`).send(suggestion).expect(403);
    await request(app).post(`/contracts/${REVIEW}/suggestions/s1/accept`).expect(403);
    await request(app).get(`/contracts/${REVIEW}/tracked-change-ids`).expect(200);
    expect(svc.createSuggestion).not.toHaveBeenCalled();
    expect(svc.resolveSuggestion).not.toHaveBeenCalled();
    expect(svc.createFeedback).not.toHaveBeenCalled();
    expect(svc.updateReviewMeta).not.toHaveBeenCalled();
    expect(svc.deleteReview).not.toHaveBeenCalled();
  });

  it("lets an editor work on the review but not share or delete it", async () => {
    asRole("editor");
    await request(app).post(`/contracts/${REVIEW}/feedback`).send(feedback).expect(201);
    await request(app).patch(`/contracts/${REVIEW}`).send({ status: "clevel_reviewed" }).expect(200);
    await request(app).post(`/contracts/${REVIEW}/suggestions`).send(suggestion).expect(201);
    await request(app).post(`/contracts/${REVIEW}/suggestions/s1/reject`).expect(200);
    await request(app).post(`/contracts/${REVIEW}/suggestions/s1/merge`).expect(404);
    expect(svc.createSuggestion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reviewId: REVIEW, userId: "u-member" }));
    expect(svc.resolveSuggestion).toHaveBeenCalledWith(expect.anything(), {
      reviewId: REVIEW,
      suggestionId: "s1",
      mode: "reject",
      userId: "u-member",
    });
    await request(app).post(`/contracts/${REVIEW}/access`).send({ email: "x@dashelectric.co", role: "viewer" }).expect(403);
    await request(app).delete(`/contracts/${REVIEW}/access/x%40dashelectric.co`).expect(403);
    await request(app).delete(`/contracts/${REVIEW}`).expect(403);
  });

  it("lets the owner (or an admin) manage access and delete", async () => {
    for (const via of ["creator", "admin"] as const) {
      asRole("owner", via);
      const grants = await request(app).get(`/contracts/${REVIEW}/access`).expect(200);
      expect(grants.body).toEqual({ scope: "direct", org_id: null, access_role: "owner", grants: [] });
      await request(app).post(`/contracts/${REVIEW}/access`).send({ email: "d@dashelectric.co", role: "viewer" }).expect(201);
      await request(app).delete(`/contracts/${REVIEW}/access/d%40dashelectric.co`).expect(204);
      await request(app).delete(`/contracts/${REVIEW}`).expect(204);
    }
    expect(svc.grantReviewAccess).toHaveBeenCalledWith(expect.anything(), {
      access: expect.objectContaining({ reviewId: REVIEW }),
      grantedBy: "u-member",
      email: "d@dashelectric.co",
      role: "viewer",
    });
    expect(svc.revokeReviewAccess).toHaveBeenCalledWith(expect.anything(), { reviewId: REVIEW, email: "d@dashelectric.co" });
    expect(svc.deleteReview).toHaveBeenCalledWith(expect.anything(), { reviewId: REVIEW });
  });

  it("refuses sharing a review with yourself", async () => {
    asRole("owner", "creator");
    await request(app)
      .post(`/contracts/${REVIEW}/access`)
      .set("x-test-email", "Owner@dashelectric.co")
      .send({ email: "owner@dashelectric.co", role: "viewer" })
      .expect(400);
    expect(svc.grantReviewAccess).not.toHaveBeenCalled();
  });

  it("maps an access-resolution crash to 500 instead of leaking the review", async () => {
    svc.resolveReviewAccess.mockRejectedValue(new Error("db down"));
    const r = await request(app).get(`/contracts/${REVIEW}`);
    expect(r.status).toBe(500);
    expect(svc.getReviewDetail).not.toHaveBeenCalled();
  });
});
