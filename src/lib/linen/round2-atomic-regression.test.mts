import assert from "node:assert/strict";
import test from "node:test";
import { updateLaundryBatchDirtyItems, advanceLaundryBatchStep, getLaundryBatchDetail } from "./batch-service.ts";

const current = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
function database() {
  const state: any = { batches: [{id:current,status:"fo_dirty_counted",business_date:"2310-01-02",pickup_round:1}], items: [{id:"old",batch_id:current,linen_item_id:1,sent_by_hotel:5,received_back:0,is_dayuse:false}, {id:"source",batch_id:source,linen_item_id:1,sent_by_hotel:5,received_back:0,is_dayuse:false}], events: [] };
  const tables: any = {laundry_batches:state.batches,laundry_batch_items:state.items,laundry_batch_events:state.events};
  const db: any = {state, rpc: async (name: string) => name === "fn_laundry_return_partition" ? {data: [],count:0,error:null} : {data:null,error:{code:"22023",message:name === "fn_laundry_replace_dirty_items" ? "created_by is required for rewash items." : "received_qty cannot exceed remaining quantity."}}, from(table: string) {
    tables[table] ??= [];
    let op = "select", payload: any, filters: ((r:any)=>boolean)[] = [];
    const rows = () => (tables[table] ?? []).filter((r:any)=>filters.every(f=>f(r)));
    const execute = () => {
      if (op === "delete") {const selected=rows(); tables[table].splice(0,tables[table].length,...tables[table].filter((r:any)=>!selected.includes(r))); return {data:null,error:null};}
      if (op === "insert") {const values=Array.isArray(payload)?payload:[payload]; (tables[table]??=[]).push(...values);return {data:values,error:null};}
      if (op === "update") {rows().forEach((r:any)=>Object.assign(r,payload));}
      return {data:rows(),error:null};
    };
    const q:any = {select(){return q;},order(){return q;},limit(){return q;},lte(){return q;},is(){return q;},in(c:string,vs:any[]){filters.push(r=>vs.includes(r[c]));return q;},eq(c:string,v:any){filters.push(r=>r[c]===v);return q;},neq(c:string,v:any){filters.push(r=>r[c]!==v);return q;},delete(){op="delete";return q;},insert(v:any){op="insert";payload=v;return q;},update(v:any){op="update";payload=v;return q;},maybeSingle:async()=>({data:execute().data?.[0]??null,error:null}),single:async()=>({data:execute().data?.[0]??null,error:null}),then(resolve:any,reject:any){return Promise.resolve(execute()).then(resolve,reject);}};
    return q;
  }};return db;
}

test("invalid rewash metadata preserves the pre-edit dirty inventory", async () => {
  const db=database(); const before=structuredClone(db.state.items);
  await assert.rejects(updateLaundryBatchDirtyItems(db,current,{items:[{linen_item_id:1,estimated_qty:9,sent_by_hotel:9}],rewashItems:[{linen_item_id:1,qty:1,photo_keys:["rewash/linen/fixture.jpg"]}]}));
  assert.deepEqual(db.state.items,before,"a rejected dirty edit must preserve every original item row");
});
test("a later invalid return preserves earlier source inventory", async () => {
  const db=database(); const before=structuredClone(db.state.items);
  await assert.rejects(advanceLaundryBatchStep(db,current,{step:"fo_return_counted",return_items:[{source_batch_id:source,linen_item_id:1,received_qty:2},{source_batch_id:source,linen_item_id:1,received_qty:-1}]}));
  assert.deepEqual(db.state.items,before,"one receive submission must not leave the earlier source increment committed");
});
test("a capped return source result is rejected instead of silently accepted", async () => {
  const db=database(); db.rpc=async()=>({data:Array.from({length:1000},()=>({})),count:1001,error:null});
  await assert.rejects(getLaundryBatchDetail(db,current),/Incomplete return partition/,"staff must not receive a silently truncated inventory selection");
});
