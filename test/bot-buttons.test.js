import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {ChannelType,Collection,PermissionFlagsBits as P} from 'discord.js';
import {createBot} from '../src/bot.js';

const user='80000000000000001',owner='80000000000000002',botId='80000000000000003';
const config={divisions:[{id:1,name:'Primeira',guild:'10000000000000001',category:'10000000000000002',adminRole:'10000000000000003'},{id:2,name:'Segunda',guild:'20000000000000001',category:'20000000000000002',adminRole:'20000000000000003'}]};
const plain=value=>value?.toJSON?.()??value;
let db,pool,bot,network,sequence=0,failCommit=false;
function discord(){
 const state={channels:new Collection(),created:[],sent:[],edited:[],actorRoles:new Set(),nativeAdmin:false};
 const guilds=new Map(config.divisions.map(d=>[d.guild,{id:d.guild,ownerId:owner,
  members:{fetch:async value=>({id:typeof value==='string'?value:value.user,roles:{cache:state.actorRoles},permissions:{has:p=>p===P.Administrator&&state.nativeAdmin}})},
  channels:{fetch:async id=>id?state.channels.get(id):new Collection([...state.channels].filter(([,ch])=>ch.guildId===d.guild)),
   create:async options=>{
    state.created.push(options);const messages=new Collection(),ch={id:String(30000000000000000n+BigInt(state.created.length)),guildId:d.guild,type:ChannelType.GuildText,parentId:options.parent,topic:options.topic,isTextBased:()=>true,
     messages:{fetch:async id=>{if(typeof id==='object')return messages;const message=messages.get(id);if(!message)throw Object.assign(new Error('Deleted'),{code:10008});return message;}},
     send:async payload=>{const m={id:String(++sequence),author:{id:botId},embeds:(payload.embeds??[]).map(plain),components:(payload.components??[]).map(plain),edit:async p=>{state.edited.push(p);m.embeds=(p.embeds??[]).map(plain);m.components=(p.components??[]).map(plain);return m;}};messages.set(m.id,m);state.sent.push(m);return m;},
     delete:async()=>state.channels.delete(ch.id)};state.channels.set(ch.id,ch);return ch;
   }}
 }]));
 state.guilds=guilds;return state;
}
function interaction(customId,{guildId=config.divisions[0].guild,userId=user,modal=false,fields={},message={components:['active']},failReply=false}={}){
 const i={id:String(++sequence),customId,guildId,guild:network.guilds.get(guildId),user:{id:userId},message,calls:[],isChatInputCommand:()=>false,isButton:()=>!modal,isModalSubmit:()=>modal,fields:{getTextInputValue:key=>fields[key]},
  deferReply:async options=>{i.calls.push(['reply',options]);i.deferred=true;},deferUpdate:async()=>{i.calls.push(['update']);i.deferred=true;},
  reply:async value=>{i.calls.push(['reply-now',value]);i.result=value;},showModal:async value=>{i.calls.push(['modal']);i.result=value.toJSON();},
  editReply:async value=>{if(failReply)throw Object.assign(new Error('Expired interaction'),{code:10062});i.result=value;if(i.calls[0]?.[0]==='update')Object.assign(message,value);}}
 ;return i;
}
async function confirmation(token='example-token'){
 const m=(await pool.query("INSERT INTO members(ifj,name,game_nick,roblox_username,discord_id,division) VALUES('123456789012345','Pessoa','PessoaJogo','PessoaRoblox',$1,1) RETURNING id",[user])).rows[0];
 await pool.query('INSERT INTO confirmations(token,member_id,discord_id,guild_id,expires_at) VALUES($1,$2,$3,$4,$5)',[token,m.id,user,config.divisions[0].guild,new Date(Date.now()+60000)]);return m;
}
before(async()=>{
 db=new PGlite();await db.exec(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));
 pool={query:async(sql,args)=>{if(sql==='COMMIT'&&failCommit){failCommit=false;throw new Error('Simulated commit failure');}const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows||r.rows.length};},connect:async()=>({...pool,release(){}})};
});
beforeEach(async()=>{if(bot)await bot.stop();failCommit=false;await pool.query('TRUNCATE staff,members,reports,tickets,jobs,panels,audit RESTART IDENTITY CASCADE');network=discord();bot=createBot(pool,config);bot.client.user={id:botId};bot.client.isReady=()=>true;bot.client.guilds.fetch=async id=>network.guilds.get(id);bot.client.channels.fetch=async id=>network.channels.get(id);});
after(async()=>{await bot.stop();await db.close();});

test('verification and report buttons acknowledge with their modal immediately, including a second guild',async()=>{
 for(const guildId of config.divisions.map(d=>d.guild))for(const customId of ['verify','report']){const i=interaction(customId,{guildId});await bot.handleInteraction(i);assert.equal(i.calls[0][0],'modal');assert.equal(i.result.custom_id,`${customId}-form`);}
});
test('confirm edits the original private card and removes used controls before subsequent clicks',async()=>{
 await confirmation();const original={components:['active']},i=interaction('confirm:example-token',{message:original});await bot.handleInteraction(i);
 assert.equal(i.calls[0][0],'update');assert.deepEqual(original.components,[]);assert.match(original.content,/Dados confirmados/);assert.equal((await pool.query('SELECT verified FROM members')).rows[0].verified,true);assert.equal((await pool.query("SELECT * FROM jobs WHERE kind='sync-role'")).rowCount,1);
});
test('cancel edits the original private card without granting access',async()=>{
 await confirmation();const original={components:['active']},i=interaction('cancel:example-token',{message:original});await bot.handleInteraction(i);
 assert.equal(i.calls[0][0],'update');assert.deepEqual(original.components,[]);assert.match(original.content,/cancelada/);assert.equal((await pool.query('SELECT verified FROM members')).rows[0].verified,false);assert.equal((await pool.query('SELECT * FROM jobs')).rowCount,0);
});
test('independent verification tokens are not blocked by a shared confirm cooldown',async()=>{
 const m=await confirmation('first');await pool.query('INSERT INTO confirmations(token,member_id,discord_id,guild_id,expires_at) VALUES($1,$2,$3,$4,$5)',['second',m.id,user,config.divisions[0].guild,new Date(Date.now()+60000)]);
 for(const token of ['first','second']){const i=interaction(`confirm:${token}`);await bot.handleInteraction(i);assert.match(i.result.content,/Dados confirmados/);}
});
test('an expired final response does not roll back the created ticket or leave an orphan close button',async()=>{
 await assert.rejects(bot.handleInteraction(interaction('ticket',{failReply:true})),/Expired interaction/);
 const rows=(await pool.query('SELECT * FROM tickets')).rows;assert.equal(rows.length,1);assert.equal(rows[0].channel_id,network.sent[0]&&[...network.channels.keys()][0]);
 assert.equal(network.sent[0].components[0].components[0].custom_id,`close:${rows[0].id}`);
});
test('ticket recovery edits its original close button after a rolled-back database commit',async()=>{
 failCommit=true;await assert.rejects(bot.handleInteraction(interaction('ticket')),/Simulated commit failure/);assert.equal((await pool.query('SELECT * FROM tickets')).rowCount,0);assert.equal(network.sent.length,1);
 await bot.stop();bot=createBot(pool,config);bot.client.user={id:botId};bot.client.isReady=()=>true;const i=interaction('ticket');await bot.handleInteraction(i);
 const t=(await pool.query('SELECT * FROM tickets')).rows[0];assert.equal(network.created.length,1);assert.equal(network.sent.length,1);assert.equal(network.edited.length,1);assert.equal(network.sent[0].components[0].components[0].custom_id,`close:${t.id}`);
});
test('invalid close identifiers receive an actionable response without a database type error',async()=>{
 network.nativeAdmin=true;const i=interaction('close:not-a-number',{userId:owner});await bot.handleInteraction(i);assert.match(i.result,/Ticket inválido/);assert.equal((await pool.query('SELECT * FROM jobs')).rowCount,0);
});
test('a Discord native administrator can close a ticket even without the configured team role',async()=>{
 await bot.handleInteraction(interaction('ticket'));const t=(await pool.query('SELECT * FROM tickets')).rows[0];network.nativeAdmin=true;
 const i=interaction(`close:${t.id}`,{userId:'80000000000000009'});i.channelId=t.channel_id;await bot.handleInteraction(i);assert.match(i.result,/resolvido/);assert.equal((await pool.query("SELECT * FROM jobs WHERE kind='close-ticket'")).rowCount,1);
});
test('closing a ticket twice queues one deletion job',async()=>{
 await bot.handleInteraction(interaction('ticket'));const t=(await pool.query('SELECT * FROM tickets')).rows[0];await bot.closeTicket(t.id,owner);await bot.closeTicket(t.id,owner);assert.equal((await pool.query("SELECT * FROM jobs WHERE kind='close-ticket'")).rowCount,1);
});
