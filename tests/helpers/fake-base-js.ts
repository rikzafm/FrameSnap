/** A cut-down base.js in the shape YouTube's player script has. */
export const FAKE_BASE_JS = [
  'var foo=1;var yt={signatureTimestamp:20123,other:2};',
  'var Qz={xR:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c},',
  'Ld:function(a){a.reverse()},',
  'Pp:function(a,b){a.splice(0,b)}};',
  'kX=function(a){a=a.split("");Qz.Ld(a,62);Qz.xR(a,3);Qz.Pp(a,2);Qz.Ld(a);return a.join("")};',
].join("\n");
