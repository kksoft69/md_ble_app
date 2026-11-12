'use strict';

const $ = id => document.getElementById(id);
const SERVICE = '7a526000-758e-4bf4-a9a0-0a349b8ac001';
const DATA = '7a526001-758e-4bf4-a9a0-0a349b8ac001';
const COMMAND = '7a526002-758e-4bf4-a9a0-0a349b8ac001';
const AXES = ['X', 'Y', 'Z'];
const COLORS = ['#54dcc0', '#6caeff', '#ffbe75'];
const POWER_STATES = ['연속동작', 'ESP 대기', '점퍼 검사', '측정 중',
                      'Sleep 응답대기', 'ESP Sleep', 'Wake 응답대기'];
const REASONS = {1:'P2P',2:'INT2 확인',3:'일과성 기상',4:'지속 이상'};
const METRICS = {
  rms: {label:'가속도 RMS', unit:'g'},
  peak: {label:'P2P', unit:'g'}
};

let device, command, notifications, deviceId = '', profile = null;
let revision = 0, txId = 0, packetCount = 0, selectedEvent = null;
const fragments = new Map();
const axisLatest = [null, null, null];
const axisHistory = [[], [], []];
const events = new Map();

function u16(a, offset) { return a[offset] | (a[offset + 1] << 8); }
function u32(a, offset) { return (a[offset] | a[offset+1]<<8 | a[offset+2]<<16 | a[offset+3]<<24) >>> 0; }
function put16(a, offset, value) { a[offset] = value & 255; a[offset+1] = value >> 8 & 255; }
function put32(a, offset, value) { for (let i=0; i<4; i++) a[offset+i] = value >>> (8*i) & 255; }
function ascii(a, offset, count) { return String.fromCharCode(...a.slice(offset, offset+count)); }
function hex(a) { return [...a].map(v => v.toString(16).padStart(2,'0')).join(''); }
function volts(mv) { return mv === 65535 || mv === 0 ? '—' : `${(mv/1000).toFixed(3)} V`; }
function timeAgo(t) { if (!t) return '—'; const s=Math.max(0,Math.floor((Date.now()-t)/1000)); return s<2?'방금':`${s}초 전`; }
function log(message) { $('log').textContent = `${new Date().toLocaleTimeString()} ${message}\n` + $('log').textContent.slice(0,5000); }

function selectTab(name) {
  for (const button of document.querySelectorAll('[data-tab]'))
    button.classList.toggle('active', button.dataset.tab === name);
  for (const tab of ['live','events','settings'])
    $(`${tab}Panel`).hidden = tab !== name;
  if (name === 'live') requestAnimationFrame(drawLiveChart);
  if (name === 'events') requestAnimationFrame(drawRawChart);
}
document.querySelectorAll('[data-tab]').forEach(button =>
  button.addEventListener('click', () => selectTab(button.dataset.tab)));

function setConnected(connected) {
  for (const id of ['disconnect','bleOff','continuous','periodic','sleep','wake','readProfile','applyProfile'])
    $(id).disabled = !connected;
  $('connect').disabled = connected;
  $('connectionBadge').className = `badge ${connected?'on':'off'}`;
  $('connectionBadge').textContent = connected ? 'BLE 연결됨' : '연결 대기';
}

function rememberDevice(id) {
  if (!id) return;
  deviceId = id;
  $('identity').textContent = `Device ID ${id}`;
  $('sensorName').textContent = `센서 ${id.slice(-8)}`;
}

function renderAxis(axis) {
  const prefix = AXES[axis].toLowerCase();
  const row = axisLatest[axis];
  if (!row) return;
  $(`${prefix}Rms`).textContent = row.rms.toFixed(4);
  $(`${prefix}Peak`).textContent = `${row.peak.toFixed(4)} g`;
  $(`${prefix}Age`).textContent = timeAgo(row.t);
}

function renderAxisDetails() {
  const row=axisLatest[Number($('detailAxis').value)];
  if(!row)return;
  $('detailCrest').textContent=row.crest.toFixed(3);
  $('detailKurtosis').textContent=row.kurtosis.toFixed(3);
  $('detailSkewness').textContent=row.skewness.toFixed(3);
  $('detailSamples').textContent=row.samples.toLocaleString();
  $('detailTime').textContent=new Date(row.t).toLocaleTimeString();
}
$('detailAxis').addEventListener('change',renderAxisDetails);

function updateAges() {
  for (let axis=0; axis<3; axis++) if (axisLatest[axis])
    $(`${AXES[axis].toLowerCase()}Age`).textContent = timeAgo(axisLatest[axis].t);
  const last = Math.max(...axisLatest.map(row => row?.t || 0));
  $('dataFreshness').textContent = last ? `${timeAgo(last)} 수신` : '데이터 대기';
  $('lastPacket').textContent = last ? `마지막 ${timeAgo(last)}` : '아직 수신 없음';
}
setInterval(updateAges, 1000);

function setupCanvas(id) {
  const canvas = $(id), box = canvas.getBoundingClientRect();
  if (box.width < 10 || box.height < 10) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(box.width*dpr);
  canvas.height = Math.round(box.height*dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr,dpr);
  return {ctx, width:box.width, height:box.height};
}

function drawAxes(ctx, width, height, lo, hi, unit, xCount) {
  const left=46, right=width-12, top=12, bottom=height-27;
  ctx.clearRect(0,0,width,height);
  ctx.fillStyle='#0b1a2a'; ctx.fillRect(0,0,width,height);
  ctx.strokeStyle='#284158'; ctx.lineWidth=1;
  ctx.fillStyle='#9db3c8'; ctx.font='11px system-ui';
  for(let j=0;j<=4;j++) {
    const y=top+(bottom-top)*j/4;
    ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
    ctx.fillText((hi-(hi-lo)*j/4).toFixed(unit==='mm/s'?2:3),3,y+4);
  }
  ctx.fillText(unit,width-38,10);
  ctx.fillText(`${Math.max(0,xCount-1)}개 전`,left,bottom+17);
  ctx.fillText('현재',right-20,bottom+17);
  return {left,right,top,bottom};
}

function drawLiveChart() {
  const surface=setupCanvas('chart'); if(!surface)return;
  const {ctx,width,height}=surface;
  const metric=$('metric').value;
  const series=axisHistory.map(rows=>rows.slice(-90).map(row=>row[metric]));
  const values=series.flat().filter(Number.isFinite);
  $('chartEmpty').hidden=values.length>0;
  if (!values.length) return;
  let lo=Math.min(...values),hi=Math.max(...values);
  const span=Math.max(0.001,hi-lo);
  lo=Math.max(0,lo-span*.2);hi=hi+span*.2;
  const bounds=drawAxes(ctx,width,height,lo,hi,METRICS[metric].unit,
                        Math.max(...series.map(s=>s.length)));
  for(let axis=0;axis<3;axis++) {
    const points=series[axis]; if(!points.length)continue;
    ctx.strokeStyle=COLORS[axis];ctx.fillStyle=COLORS[axis];ctx.lineWidth=2;
    ctx.beginPath();
    points.forEach((v,i)=>{
      const x=bounds.left+(bounds.right-bounds.left)*i/Math.max(1,points.length-1);
      const y=bounds.bottom-(v-lo)/(hi-lo)*(bounds.bottom-bounds.top);
      i?ctx.lineTo(x,y):ctx.moveTo(x,y);
      if(points.length===1){ctx.arc(x,y,3,0,2*Math.PI);ctx.fill();}
    });
    if(points.length>1)ctx.stroke();
  }
  $('chartCaption').textContent=`${METRICS[metric].label} · 최근 축별 최대 90개`;
}
$('metric').addEventListener('change',drawLiveChart);
window.addEventListener('resize',()=>{drawLiveChart();drawRawChart()});

function handleStats(a) {
  if (a.length!==68 || ascii(a,0,4)!=='MDV1' || a[4]!==1) return;
  const axis=a[67]-1; // MDV1 payload <Q7fIBhB: final B is the axis.
  if (axis<0 || axis>2) {log(`알 수 없는 축 ${a[67]}`);return;}
  const view=new DataView(a.buffer,a.byteOffset,a.byteLength);
  const row={
    t:Date.now(), rms:view.getFloat32(32,true), velocity:view.getFloat32(36,true),
    peak:view.getFloat32(40,true), crest:view.getFloat32(44,true),
    kurtosis:view.getFloat32(48,true), skewness:view.getFloat32(52,true),
    rpm:view.getFloat32(56,true), samples:view.getUint32(60,true),
    temperature:view.getInt16(65,true)/100
  };
  if(!Number.isFinite(row.rms)||!Number.isFinite(row.velocity)||!Number.isFinite(row.peak))return;
  rememberDevice(hex(a.slice(8,16)));
  axisLatest[axis]=row;axisHistory[axis].push(row);
  if(axisHistory[axis].length>180)axisHistory[axis].shift();
  packetCount++;
  $('packetCount').textContent=packetCount.toLocaleString();
  $('temperature').textContent=`${row.temperature.toFixed(2)} °C`;
  renderAxis(axis);renderAxisDetails();updateAges();drawLiveChart();
}

function handleStatus(a) {
  if(a.length<56||ascii(a,0,4)!=='MDS1')return;
  rememberDevice(hex(a.slice(8,16)));
  const bat=u16(a,36),nrf=u16(a,40),cycle=u16(a,48),awake=u16(a,50);
  $('batteryVoltage').textContent=volts(bat);
  $('batteryHint').textContent=bat===65535||bat===0?'ESP 측정값 없음':`최저 ${volts(u16(a,38))}`;
  $('nrfVoltage').textContent=volts(nrf);
  $('cycle').value=cycle;$('awake').value=awake;
  $('powerMode').textContent=POWER_STATES[a[52]]||`상태 ${a[52]}`;
  $('powerCycleInfo').textContent=(a[53]&16)?`${cycle}초 / ${awake}초`:'연속동작';
  $('statusDetail').textContent=`BLE 접속 중 · ESP 상태 경과 ${u16(a,42)}초 · Cycle ${u32(a,44)} · 누락 ${u32(a,24)}패킷`;
}

function handleAnomalyStatus(a) {
  if(a.length!==30||ascii(a,0,4)!=='MDA1')return;
  const desired=u32(a,13),applied=u32(a,17);
  $('profileState').textContent=`v${applied} / 목표 v${desired}`;
  $('profileReply').textContent=`목표 v${desired} · ESP 적용 v${applied} · 결과 ${a[29]}`;
}

function renderEvents() {
  $('eventCount').textContent=events.size;
  $('eventBadge').textContent=`${events.size}건`;
  const list=[...events.values()].reverse().slice(0,20);
  $('eventList').innerHTML=list.length?list.map(e=>
    `<button class="event-item ${e.seq===selectedEvent?'active':''}" data-event="${e.seq}"><strong>${REASONS[e.reason]||`원인 ${e.reason}`} · #${e.seq}</strong><span>${new Date(e.t).toLocaleString()} · ${e.axes===7?'XYZ':e.axes} · ${e.samples}시점</span><span class="event-meta">RMS ${e.rms.join(' / ')} mg · raw ${e.received.size}/${e.samples}${e.crcOk===null?'':e.crcOk?' · CRC 완료':' · CRC 오류'}</span></button>`).join(''):'<div class="empty">이벤트 수신 대기</div>';
  $('eventList').querySelectorAll('[data-event]').forEach(button=>button.onclick=()=>{
    selectedEvent=Number(button.dataset.event);renderEvents();drawRawChart();
  });
}

function handleEvent(a) {
  if(a.length!==40||ascii(a,0,4)!=='MDE1')return;
  const seq=u32(a,12),axes=a[18],samples=u16(a,34);
  if(!samples||samples>1024||![1,2,4,7].includes(axes))return;
  const width=axes===7?3:1;
  events.set(seq,{seq,t:Date.now(),reason:a[16],axes,samples,
    rms:[u16(a,20),u16(a,22),u16(a,24)],
    p2p:[u16(a,26),u16(a,28),u16(a,30)],
    battery:u16(a,32),crc:u32(a,36),crcOk:null,
    data:new Int16Array(samples*width),received:new Set()});
  if(events.size>20)events.delete(events.keys().next().value);
  selectedEvent=seq;renderEvents();drawRawChart();
  log(`이벤트 #${seq} · raw ${samples}시점`);
}

function crc32(a) {
  let value=0xffffffff;
  for(const byte of a){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}
  return(value^0xffffffff)>>>0;
}

function handleRaw(a) {
  if(a.length<22||ascii(a,0,4)!=='MDR1')return;
  const seq=u32(a,12),e=events.get(seq);if(!e)return;
  const offset=u16(a,16),count=a[18],axes=a[19],width=e.axes===7?3:1;
  if(axes!==e.axes||!count||offset+count>e.samples||a.length!==20+count*width*2)return;
  const view=new DataView(a.buffer,a.byteOffset,a.byteLength);
  for(let i=0;i<count;i++){
    for(let axis=0;axis<width;axis++)
      e.data[(offset+i)*width+axis]=view.getInt16(20+(i*width+axis)*2,true);
    e.received.add(offset+i);
  }
  if(e.received.size===e.samples){
    e.crcOk=crc32(new Uint8Array(e.data.buffer))===e.crc;
    log(`raw #${seq} ${e.crcOk?'CRC 완료':'CRC 오류'}`);
  }
  if(e.received.size===e.samples||e.received.size%60<6){renderEvents();if(selectedEvent===seq)drawRawChart();}
}

function drawRawChart() {
  const surface=setupCanvas('rawChart');if(!surface)return;
  const {ctx,width,height}=surface;
  const e=events.get(selectedEvent);
  const available=e&&e.received.size>0;
  $('rawEmpty').hidden=!!available;
  if(!e){$('rawState').textContent='이벤트를 선택하면 파형을 표시합니다.';$('rawDetail').textContent='';return;}
  $('rawState').textContent=`#${e.seq} · ${e.received.size}/${e.samples}시점 · ${(e.received.size*e.data.length/e.samples*2).toLocaleString()} B${e.crcOk===null?'':e.crcOk?' · CRC 확인':' · CRC 오류'}`;
  $('rawDetail').textContent=`${(e.samples/26667*1000).toFixed(1)} ms · ${e.axes===7?'X / Y / Z':'단일 축'} · ${e.battery===65535?'배터리 미측정':`이벤트 BAT ${volts(e.battery)}`}`;
  if(!available)return;
  const stride=e.axes===7?3:1;
  let limit=.01;
  for(const sample of e.data)limit=Math.max(limit,Math.abs(sample/8192));
  limit=Math.min(4,limit*1.15);
  const bounds=drawAxes(ctx,width,height,-limit,limit,'g',e.samples);
  for(let axis=0;axis<stride;axis++){
    ctx.strokeStyle=COLORS[axis];ctx.lineWidth=1.4;ctx.beginPath();let open=false;
    for(let i=0;i<e.samples;i++){
      if(!e.received.has(i)){open=false;continue;}
      const x=bounds.left+(bounds.right-bounds.left)*i/Math.max(1,e.samples-1);
      const y=bounds.bottom-(e.data[i*stride+axis]/8192+limit)/(2*limit)*(bounds.bottom-bounds.top);
      open?ctx.lineTo(x,y):ctx.moveTo(x,y);open=true;
    }
    ctx.stroke();
  }
}

function handleProfile(a) {
  if(a.length!==71||ascii(a,0,4)!=='MDBP')return;
  revision=u32(a,5);profile=a.slice(22);
  const flags=u16(profile,0),rms=u16(profile,12);
  $('threshold').value=rms||100;$('cooldown').value=u16(profile,44);
  $('raw').checked=!!(flags&32);$('int2').checked=!!(flags&2);
  $('profileReply').textContent=`현재 설정 v${revision} · ESP 적용 v${u32(a,9)}`;
}

function handlePacket(kind,a) {
  if(kind===1)handleStats(a);
  else if(kind===2)handleStatus(a);
  else if(kind===3)handleAnomalyStatus(a);
  else if(kind===4)handleEvent(a);
  else if(kind===5)handleRaw(a);
  else if(kind===6&&ascii(a,0,4)==='MDPR')$('powerReply').textContent=`명령 ${a[5]} · 결과 ${a[6]} · 상태 ${POWER_STATES[a[7]]||a[7]}`;
  else if(kind===7&&ascii(a,0,4)==='MDAR')$('profileReply').textContent=`설정 ${a[5]===0?'저장 완료':`오류 ${a[5]}`} · v${u32(a,6)}`;
  else if(kind===8)handleProfile(a);
}

function onNotification(event) {
  const value=event.target.value;
  const a=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(a.length<7)return;
  const kind=a[0],id=u16(a,1),total=u16(a,3),offset=u16(a,5);
  if(total>256||offset+a.length-7>total)return;
  const key=`${kind}:${id}`;
  let entry=fragments.get(key);
  if(!entry||offset===0){entry={buffer:new Uint8Array(total),next:0};fragments.set(key,entry);}
  if(offset!==entry.next)return;
  entry.buffer.set(a.subarray(7),offset);entry.next+=a.length-7;
  if(entry.next===total){fragments.delete(key);handlePacket(kind,entry.buffer);}
}

async function send(body) {
  if(!command)throw Error('BLE 센서와 연결되지 않았습니다');
  const id=++txId,step=13;
  for(let offset=0;offset<body.length;offset+=step){
    const n=Math.min(step,body.length-offset),frame=new Uint8Array(7+n);
    frame[0]=128;put16(frame,1,id);put16(frame,3,body.length);put16(frame,5,offset);
    frame.set(body.subarray(offset,offset+n),7);
    await command.writeValueWithResponse(frame);
  }
}

async function power(action,enabled=false) {
  try{
    const cycle=Number($('cycle').value),awake=Number($('awake').value);
    if(action===1&&(!Number.isInteger(cycle)||cycle<10||cycle>3600||
       !Number.isInteger(awake)||awake<2||awake>300||awake>=cycle))
      throw Error('주기 10~3600초, Awake 2~300초이며 Awake가 주기보다 짧아야 합니다');
    const body=new Uint8Array(16);body[0]=2;
    body.set([77,68,80,67,1,action,enabled?1:0],1);
    put16(body,8,cycle);put16(body,10,awake);put32(body,12,Date.now()>>>0);
    await send(body);$('powerReply').textContent='명령 전송 · 응답 대기';
  }catch(error){$('powerReply').textContent=error.message;}
}

async function applyProfile() {
  try{
    if(!profile)throw Error('먼저 현재 설정을 읽으세요');
    if(!deviceId)throw Error('Device ID 수신을 기다리세요');
    const p=profile.slice(),mg=Number($('threshold').value),cool=Number($('cooldown').value);
    if(!Number.isInteger(mg)||mg<1||mg>4000||!Number.isInteger(cool)||cool<0||cool>3600)
      throw Error('임계값 또는 재발생 제한 범위 오류');
    let flags=u16(p,0);flags=(flags|1)&~28;
    flags=$('raw').checked?flags|32:flags&~32;
    flags=$('int2').checked?flags|2:flags&~2;
    put16(p,0,flags);p[2]=7;
    p[3]=Math.max(1,Math.min(63,Math.ceil(mg/15.625)));p[4]=1;
    put16(p,6,mg);put16(p,8,Math.min(8000,mg*2));
    for(let i=0;i<3;i++){put16(p,12+i*2,mg);put16(p,18+i*2,0);}
    put16(p,44,cool);p[46]=7;put16(p,47,1024);
    const body=new Uint8Array(77);body[0]=3;
    body.set([77,68,65,67,1,1],1);
    body.set(Uint8Array.from(deviceId.match(/../g).map(h=>parseInt(h,16))),7);
    put32(body,15,revision+1);put32(body,19,Date.now()>>>0);
    body[23]=49;put32(body,24,crc32(p));body.set(p,28);
    await send(body);$('profileReply').textContent='설정 전송 · ESP 적용 상태 확인 중';
    revision++;profile=p;
  }catch(error){$('profileReply').textContent=error.message;}
}

$('connect').onclick=async()=>{
  try{
    if(!navigator.bluetooth||!isSecureContext)
      throw Error('HTTPS의 Android Chrome에서 열어야 BLE를 사용할 수 있습니다');
    device=await navigator.bluetooth.requestDevice({filters:[{services:[SERVICE]}]});
    device.addEventListener('gattserverdisconnected',()=>{
      command=null;setConnected(false);
      $('connection').textContent='연결 해제 · Thread 복귀 대기';log('BLE 연결 해제');
    });
    const server=await device.gatt.connect(),service=await server.getPrimaryService(SERVICE);
    notifications=await service.getCharacteristic(DATA);
    command=await service.getCharacteristic(COMMAND);
    await notifications.startNotifications();
    notifications.addEventListener('characteristicvaluechanged',onNotification);
    setConnected(true);
    $('connection').textContent=`${device.name||'MD-VIB'} 연결됨 · 센서 데이터를 수신 중입니다`;
    log('BLE 연결됨');
    await send(Uint8Array.of(4));
  }catch(error){log(`연결 오류: ${error.message}`);$('connection').textContent=error.message;}
};
$('disconnect').onclick=()=>device?.gatt?.disconnect();
$('bleOff').onclick=()=>send(Uint8Array.of(1,0)).catch(error=>log(error.message));
$('continuous').onclick=()=>power(1,false);
$('periodic').onclick=()=>power(1,true);
$('sleep').onclick=()=>power(2);
$('wake').onclick=()=>power(3);
$('readProfile').onclick=()=>send(Uint8Array.of(4)).catch(error=>$('profileReply').textContent=error.message);
$('applyProfile').onclick=applyProfile;

let installPrompt;
window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();installPrompt=event;$('installApp').hidden=false;
});
$('installApp').onclick=async()=>{
  if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;
  installPrompt=null;$('installApp').hidden=true;
};
window.addEventListener('appinstalled',()=>{
  $('appStatus').textContent='앱 설치 완료 · 오프라인 실행 가능';$('installApp').hidden=true;
});
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(async()=>{
    await navigator.serviceWorker.ready;
    $('appStatus').textContent='오프라인 실행 준비 완료 · 센서 통신은 BLE';
  }).catch(error=>$('appStatus').textContent=`오프라인 준비 실패: ${error.message}`);
}else $('appStatus').textContent='이 브라우저는 오프라인 설치를 지원하지 않습니다';
