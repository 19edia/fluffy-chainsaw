import express from 'express';
import {randomInt,timingSafeEqual} from 'node:crypto';
import {rateLimit} from 'express-rate-limit';
import {tx,audit} from './db.js';
import {token,hash,passwordHash,passwordMatches,text} from './security.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hours=8*3600000;
const usernameOf=value=>{
 const name=text(value,'Usuário',64,3).toLowerCase();
 if(!/^[a-z0-9_.-]+$/.test(name))throw fail('Usuário: use letras, números, ponto, hífen ou sublinhado.');
 return name;
};
const limit=(count)=>rateLimit({windowMs:15*60000,limit:count,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Muitas tentativas. Aguarde 15 minutos.'}});

export function memberAuthRoutes(app,pool,config,bot){
 const router=express.Router();
 const cookieOptions={httpOnly:true,secure:config.production,sameSite:'strict',path:'/',maxAge:hours};
 const digest=value=>hash(value,config.secret);
 const codeDigest=(challenge,discordId,code)=>digest(`member-signup:${challenge}:${discordId}:${code}`);
 const makeSession=async(c,accountId)=>{
  const value=token();
  const inserted=await c.query(`INSERT INTO member_sessions(token_hash,account_id,csrf,expires_at)
   SELECT $1,a.id,$3,$4 FROM member_accounts a JOIN members m ON m.id=a.member_id
   WHERE a.id=$2 AND a.active=TRUE AND a.discord_id=m.discord_id RETURNING token_hash`,[digest(value),accountId,token(),new Date(Date.now()+hours)]);
  if(!inserted.rowCount)throw fail('Seu IFJ foi alterado ou cancelado. Procure a equipe.',401);
  return value;
 };

 router.post('/register/start',limit(20),async(req,res)=>{
  const body=req.body??{};
  if(typeof body.ifj!=='string'||!/^\d{15}$/.test(body.ifj))throw fail('Informe os 15 números do seu IFJ.');
  const username=usernameOf(body.username),password=text(body.password,'Senha',128,12);
  if(!bot.ready()||!bot.sendMemberSignupCode)throw fail('O bot está desconectado. Aguarde a equipe conectar o bot para confirmar seu cadastro.',503);
  const password_hash=await passwordHash(password),challengeId=token(),code=String(randomInt(100000,1000000));
  await tx(pool,async c=>{
   const member=(await c.query('SELECT id,discord_id FROM members WHERE ifj=$1 FOR UPDATE',[body.ifj])).rows[0];
   if(!member)throw fail('IFJ não encontrado. Confira sua carteira ou fale com a equipe.',404);
   if((await c.query('SELECT id FROM member_accounts WHERE member_id=$1',[member.id])).rowCount)throw fail('Este IFJ já tem uma conta. Entre com seu usuário e senha.',409);
   if((await c.query('SELECT id FROM member_accounts WHERE username=$1',[username])).rowCount)throw fail('Este usuário já está em uso. Escolha outro.',409);
   const prior=(await c.query('SELECT created_at FROM member_registration_challenges WHERE member_id=$1',[member.id])).rows[0];
   if(prior&&Date.now()-new Date(prior.created_at).getTime()<60000)throw fail('Aguarde um minuto antes de pedir outro código.',429);
   await c.query(`INSERT INTO member_registration_challenges(member_id,challenge_hash,discord_id,username,password_hash,code_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(member_id) DO UPDATE SET challenge_hash=$2,discord_id=$3,username=$4,password_hash=$5,code_hash=$6,expires_at=$7,attempts=0,created_at=now()`,
    [member.id,digest(challengeId),member.discord_id,username,password_hash,codeDigest(challengeId,member.discord_id,code),new Date(Date.now()+10*60000)]);
   try{await bot.sendMemberSignupCode(member.discord_id,code,username);}catch{throw fail('Não foi possível enviar o código ao Discord do seu IFJ. Permita mensagens privadas do bot e participe de uma divisão para tentar novamente.');}
  });
  res.json({challenge_id:challengeId,message:'Código enviado no privado do Discord vinculado ao seu IFJ. Ele vale por 10 minutos.'});
 });

 router.post('/register/confirm',limit(30),async(req,res)=>{
  const {challenge_id,code}=req.body??{};
  if(typeof challenge_id!=='string'||!(/^[a-f0-9]{64}$/).test(challenge_id)||typeof code!=='string'||!/^\d{6}$/.test(code))throw fail('Informe o código de seis números recebido no Discord.');
  const result=await tx(pool,async c=>{
   const reference=(await c.query('SELECT member_id FROM member_registration_challenges WHERE challenge_hash=$1',[digest(challenge_id)])).rows[0];
   if(!reference)return {error:'Código expirado ou já utilizado. Inicie seu cadastro novamente.',status:400};
   // Match the lock order used by registration and IFJ editing/deletion.
   const member=(await c.query('SELECT id,discord_id FROM members WHERE id=$1 FOR UPDATE',[reference.member_id])).rows[0];
   const pending=(await c.query('SELECT * FROM member_registration_challenges WHERE member_id=$1 AND challenge_hash=$2 FOR UPDATE',[reference.member_id,digest(challenge_id)])).rows[0];
   if(!member||!pending||member.discord_id!==pending.discord_id)return {error:'Seu IFJ foi alterado ou cancelado. Inicie o cadastro novamente.',status:400};
   if(new Date(pending.expires_at).getTime()<=Date.now()||pending.attempts>=5)return {error:'Código expirado ou bloqueado. Solicite outro código.',status:400};
   if(!timingSafeEqual(Buffer.from(codeDigest(challenge_id,pending.discord_id,code)),Buffer.from(pending.code_hash))){
    await c.query('UPDATE member_registration_challenges SET attempts=attempts+1 WHERE member_id=$1',[member.id]);
    return {error:'Código incorreto. Confira a mensagem privada do bot.',status:400};
   }
   if((await c.query('SELECT id FROM member_accounts WHERE member_id=$1 OR username=$2',[member.id,pending.username])).rowCount)return {error:'Este IFJ ou usuário já tem uma conta. Entre ou escolha outro usuário.',status:409};
   const account=(await c.query('INSERT INTO member_accounts(member_id,discord_id,username,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[member.id,pending.discord_id,pending.username,pending.password_hash])).rows[0];
   if(!account)return {error:'Este IFJ ou usuário já tem uma conta. Entre ou escolha outro usuário.',status:409};
   const session=await makeSession(c,account.id);
   await c.query('DELETE FROM member_registration_challenges WHERE member_id=$1',[member.id]);
   await audit(c,`membro:${account.id}`,'Conta de membro criada',{memberId:member.id});
   return {session};
  });
  if(result.error)return res.status(result.status).json({error:result.error});
  res.cookie('ifj_member_session',result.session,cookieOptions).status(201).json({authenticated:true});
 });

 let dummyHash;
 router.post('/login',limit(10),async(req,res)=>{
  const username=usernameOf(req.body?.username),password=text(req.body?.password,'Senha',128);
  const account=(await pool.query(`SELECT a.* FROM member_accounts a JOIN members m ON m.id=a.member_id
   WHERE a.username=$1 AND a.discord_id=m.discord_id`,[username])).rows[0];
  dummyHash ||= await passwordHash(token());
  const valid=await passwordMatches(password,account?.password_hash||dummyHash);
  if(!account?.active||!valid)throw fail('Usuário ou senha inválidos, ou IFJ cancelado.',401);
  const session=await makeSession(pool,account.id);
  res.cookie('ifj_member_session',session,cookieOptions).json({authenticated:true});
 });

 router.use(async(req,res,next)=>{
  const cookie=(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('ifj_member_session='))?.slice('ifj_member_session='.length);
  if(cookie&&/^[a-f0-9]{64}$/.test(cookie)){
   const session=(await pool.query(`SELECT s.token_hash,s.csrf,a.username,m.name FROM member_sessions s
    JOIN member_accounts a ON a.id=s.account_id JOIN members m ON m.id=a.member_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active=TRUE AND a.discord_id=m.discord_id`,[digest(cookie)])).rows[0];
   if(session){req.memberSession=session;return next();}
  }
  res.clearCookie('ifj_member_session',{path:'/'}).status(401).json({error:'Entre na sua conta de membro.'});
 });
 router.get('/me',(req,res)=>res.json({name:req.memberSession.name,username:req.memberSession.username,csrf:req.memberSession.csrf}));
 router.post('/logout',async(req,res)=>{
  if(req.get('x-csrf-token')!==req.memberSession.csrf)throw fail('Sessão inválida. Recarregue a página.',403);
  await pool.query('DELETE FROM member_sessions WHERE token_hash=$1',[req.memberSession.token_hash]);
  res.clearCookie('ifj_member_session',{path:'/'}).json({ok:true});
 });
 // A member route must never fall through into the moderation API.
 router.use((_req,res)=>res.status(404).json({error:'Rota não encontrada.'}));
 app.use('/api/member',router);
}
