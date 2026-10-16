import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, testDatabaseUrls, truncateAll, type TestDatabaseUrls } from "../test-support/postgres.js";
import { JurisdictionService } from "./jurisdiction.service.js";

const urls=testDatabaseUrls();
describe.skipIf(!urls)("authoritative voting eligibility (real RLS database)",()=>{
 let prisma:PrismaService,admin:Client,service:JurisdictionService;
 const jurisdictionId=randomUUID(),problemId=randomUUID(),proposalId=randomUUID();
 const citizens=Array.from({length:6},()=>randomUUID());
 beforeAll(async()=>{
  await truncateAll(urls as TestDatabaseUrls);prisma=newTestPrismaService(urls as TestDatabaseUrls);await prisma.onModuleInit();
  admin=new Client({connectionString:urls!.admin});await admin.connect();
  service=new JurisdictionService(prisma,{isActiveHolder:async()=>false},{emit:async()=>undefined});
  await admin.query("INSERT INTO jurisdiction(id,name,scope_level,boundary_ref,min_residency_days) VALUES($1,'fixture','municipality','fixture',180)",[jurisdictionId]);
  for(let i=0;i<citizens.length;i++){
   await admin.query("INSERT INTO citizen(id,public_handle,legal_identity_hash,status,citizenship_status) VALUES($1,$2,$2,$3,$4)",[citizens[i],`fixture-${i}`,i===1?'pending':'active',i===5?'suspended':'citizen']);
   await admin.query("INSERT INTO residency(citizen_id,jurisdiction_id,start_date,verified) VALUES($1,$2,CURRENT_DATE-$3::integer,$4)",[citizens[i],jurisdictionId,i===3?1:365,i!==2]);
   if(i!==4)await admin.query("INSERT INTO jurisdiction_membership(citizen_id,jurisdiction_id) VALUES($1,$2)",[citizens[i],jurisdictionId]);
  }
  await admin.query("INSERT INTO problem(id,author_id,title,description,affected_area,jurisdiction_id) VALUES($1,$2,'p','p','p',$3)",[problemId,citizens[0],jurisdictionId]);
  await admin.query("INSERT INTO proposal(id,problem_id,author_id,title,description,support_threshold,status,scope_jurisdiction_id) VALUES($1,$2,$3,'p','p',10,'voting',$4)",[proposalId,problemId,citizens[0],jurisdictionId]);
 });
 afterAll(async()=>{await admin?.end();await prisma?.onModuleDestroy();});
 it("excludes pending, unverified, recent, non-member and suspended identities",async()=>{
  expect(await service.eligibleCitizens(proposalId,jurisdictionId)).toEqual({citizen_ids:[citizens[0]],next_cursor:""});
  expect((await service.eligibleCitizens(proposalId,jurisdictionId,citizens[0])).citizen_ids).toEqual([]);
 });
 it("rejects wrong proposal jurisdiction and malformed cursors",async()=>{
  await expect(service.eligibleCitizens(proposalId,randomUUID())).rejects.toThrow();
  await expect(service.eligibleCitizens(proposalId,jurisdictionId,"------------------------------------")).rejects.toThrow();
 });
});
