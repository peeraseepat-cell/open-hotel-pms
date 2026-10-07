import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { updateLaundryBatchDirtyItems, advanceLaundryBatchStep, getLaundryBatchDetail } from "./batch-service.ts";
const envPath = process.env.LINEN_LOCAL_DB_ENV;
assert.ok(envPath, "LINEN_LOCAL_DB_ENV must point to the isolated local connection file");
const env = Object.fromEntries(readFileSync(envPath,"utf8").split(/\r?\n/).filter(line=>line.includes("=")).map(line=>{const i=line.indexOf("="); return [line.slice(0,i),line.slice(i+1).replace(/^['"]|['"]$/g,"")];}));
const db=createClient(env.API_URL, env.SERVICE_ROLE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
const batchIds=["82100000-0000-4000-8000-000000000001","82100000-0000-4000-8000-000000000002","82100000-0000-4000-8000-000000000003"];
async function checked(query: any) { const r=await query; assert.equal(r.error,null, r.error?.message); return r.data; }
async function fixture() {
  await cleanup();
  const items=await checked(db.from("linen_items").select("id").limit(1));assert.ok(items.length);
  const linenId=items[0].id;
  await checked(db.from("laundry_batches").insert(batchIds.map((id,i)=>({id,business_date:`2311-01-0${i+1}`,pickup_round:1,status:"fo_dirty_counted"}))));
  await checked(db.from("laundry_batch_items").insert([{batch_id:batchIds[0],linen_item_id:linenId,is_dayuse:false,sent_by_hotel:5,estimated_qty:5},{batch_id:batchIds[1],linen_item_id:linenId,is_dayuse:false,sent_by_hotel:3,estimated_qty:3},{batch_id:batchIds[1],linen_item_id:linenId,is_dayuse:true,sent_by_hotel:4,estimated_qty:4}]));
  return linenId;
}
async function cleanup(){await checked(db.from("laundry_pending_items").delete().in("source_batch_id",batchIds));await checked(db.from("laundry_batches").delete().in("id",batchIds));}

test("native dirty edit rejection rolls back original row identity and quantities", async()=>{
 const linenId=await fixture();try{
  const before=await checked(db.from("laundry_batch_items").select("*").eq("batch_id",batchIds[0]));
  await assert.rejects(updateLaundryBatchDirtyItems(db,batchIds[0],{items:[{linen_item_id:linenId,estimated_qty:9,sent_by_hotel:9}],rewashItems:[{linen_item_id:linenId,qty:1,photo_keys:["rewash/linen/fixture.jpg"]}]}));
  const after=await checked(db.from("laundry_batch_items").select("*").eq("batch_id",batchIds[0]));
  assert.deepEqual(after,before,"invalid rewash metadata must not destroy original inventory rows");
 }finally{await cleanup();}
});
test("native receive rejects later bad input without committing earlier increment",async()=>{
 const linenId=await fixture();try{
  await assert.rejects(advanceLaundryBatchStep(db,batchIds[2],{step:"fo_return_counted",return_items:[{source_batch_id:batchIds[0],linen_item_id:linenId,received_qty:2},{source_batch_id:batchIds[0],linen_item_id:linenId,received_qty:-1}]}));
  const rows=await checked(db.from("laundry_batch_items").select("received_back").eq("batch_id",batchIds[0]));
  assert.equal(rows[0].received_back,0,"failed receive transaction must leave source stock unchanged");
  const current=await checked(db.from("laundry_batches").select("status").eq("id",batchIds[2]).single());assert.equal(current.status,"fo_dirty_counted");
 }finally{await cleanup();}
});
test("native merged pending marker fills normal and day-use rows together",async()=>{
 const linenId=await fixture();try{
  const pending=await checked(db.from("laundry_pending_items").insert({source_batch_id:batchIds[1],linen_item_id:linenId,pending_qty:7,reason:"return_short"}).select("id").single());
  await assert.doesNotReject(advanceLaundryBatchStep(db,batchIds[2],{step:"fo_return_counted",pending_resolved:[{pending_item_id:pending.id}]}),"two authoritative variants must resolve as one merged pending selection");
  const rows=await checked(db.from("laundry_batch_items").select("received_back,sent_by_hotel").eq("batch_id",batchIds[1]));assert.ok(rows.every((row:any)=>row.received_back===row.sent_by_hotel));
 }finally{await cleanup();}
});

test("native repeated receive press applies source quantities once",async()=>{
 const linenId=await fixture();try{
  const request={step:"fo_return_counted" as const,return_items:[{source_batch_id:batchIds[0],linen_item_id:linenId,received_qty:2}]};
  const results=await Promise.allSettled([advanceLaundryBatchStep(db,batchIds[2],request),advanceLaundryBatchStep(db,batchIds[2],request)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1,"batch row lock must reject the second press after the first advances");
  const row=await checked(db.from("laundry_batch_items").select("received_back").eq("batch_id",batchIds[0]).single());assert.equal(row.received_back,2);
  const events=await checked(db.from("laundry_batch_events").select("id").eq("batch_id",batchIds[2]).eq("event_type","fo_return_counted"));assert.equal(events.length,1);
 }finally{await cleanup();}
});

test("native capped source query refuses an incomplete return selection",async()=>{
 const linenId=await fixture();
 const extraIds=Array.from({length:1001},(_,i)=>`82400000-0000-4000-8000-${String(i+1).padStart(12,"0")}`);
 try{
  await checked(db.from("laundry_batches").insert(extraIds.map((id,i)=>({id,business_date:"2309-01-01",pickup_round:i+1,status:"fo_dirty_counted"}))));
  await checked(db.from("laundry_batch_items").insert(extraIds.map(id=>({batch_id:id,linen_item_id:linenId,sent_by_hotel:1,estimated_qty:1}))));
  await assert.rejects(getLaundryBatchDetail(db,batchIds[2]),/Incomplete return partition/,"1000-row API cap must produce an explicit completeness error");
 }finally{
  for(let i=0;i<extraIds.length;i+=100) await checked(db.from("laundry_batches").delete().in("id",extraIds.slice(i,i+100)));
  await cleanup();
 }
});
