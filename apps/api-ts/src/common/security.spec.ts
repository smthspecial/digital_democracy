import { Controller, Get, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RequiredCitizenId } from "./citizen-id.decorator.js";
import { SignedRequestVerifier } from "./internal-service.guard.js";
import { createRateLimitMiddleware } from "./rate-limit.js";
import { installTestAuth, testBearer } from "../test-support/auth.js";

@Controller("security-fixture")
class SecurityFixture {
 @Get("write") write(@RequiredCitizenId() citizen: string) {return {citizen};}
 @Get("approval") approve(@RequiredCitizenId("T3") citizen: string) {return {citizen};}
}

describe("citizen assurance boundary",()=>{
 let app: INestApplication;
 beforeAll(async()=>{const module=await Test.createTestingModule({controllers:[SecurityFixture]}).compile();app=module.createNestApplication();installTestAuth(app);await app.init();});
 afterAll(async()=>{await app.close();});
 it("requires T2 for a write and T3 for approval, ignoring citizen headers",async()=>{
  for(const [tier,write,approval] of [["T1",403,403],["T2",200,403],["T3",200,200]] as const){
   expect((await request(app.getHttpServer()).get("/security-fixture/write").set("Authorization",testBearer("owner",tier)).set("X-Citizen-ID","forged")).status).toBe(write);
   const response=await request(app.getHttpServer()).get("/security-fixture/approval").set("Authorization",testBearer("owner",tier));expect(response.status).toBe(approval);if(approval===200)expect(response.body.citizen).toBe("owner");
  }
 });
});

describe("signed request and request limits",()=>{
 it("consumes a signature once and includes the query string in its signature",async()=>{
  const timestamp=Math.floor(Date.now()/1000).toString(),nonce=randomBytes(16).toString("hex"),path="/internal?cursor=one";
  const digest=createHash("sha256").update("").digest("hex");
  const signature=createHmac("sha256","test-secret").update(`api-go\nGET\n${path}\n${timestamp}\n${nonce}\n${digest}`).digest("hex");
  const headers:Record<string,string>={"x-dd-service":"api-go","x-dd-timestamp":timestamp,"x-dd-nonce":nonce,"x-dd-signature":signature};
  const req={method:"GET",originalUrl:path,header:(name:string)=>headers[name]} as Request;
  const verifier=new SignedRequestVerifier();expect(await verifier.verify(req,"api-go","test-secret")).toBe(true);
  expect(await verifier.verify(req,"api-go","test-secret")).toBe(false);
  expect(await new SignedRequestVerifier().verify({...req,originalUrl:"/internal?cursor=two"} as Request,"api-go","test-secret")).toBe(false);
 });
 it("limits the socket peer rather than spoofable forwarded addresses",()=>{
  const middleware=createRateLimitMiddleware(),next=vi.fn();
  const res={setHeader:vi.fn(),status:vi.fn(),json:vi.fn()} as unknown as Response;vi.mocked(res.status).mockReturnValue(res);
  for(let i=0;i<121;i++) middleware({socket:{remoteAddress:"127.0.0.1"},headers:{"x-forwarded-for":`192.0.2.${i}`}} as Request,res,next);
  expect(next).toHaveBeenCalledTimes(120);expect(res.status).toHaveBeenCalledWith(429);
 });
});
