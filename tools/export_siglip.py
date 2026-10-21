# Build an ONNX graph of the SigLIP B/16 image encoder from the big_vision npz weights.
import numpy as np, onnx, sys
from onnx import helper as h, TensorProto as TP, numpy_helper as nh
z=np.load('siglip_b16.npz'); P='params/img/'
W={k[len(P):]:z[k].astype(np.float32) for k in z.files if k.startswith(P)}
RES=int(sys.argv[1]) if len(sys.argv)>1 else 224; G=RES//16; T=G*G
pos=W['pos_embedding'].reshape(14,14,768)
if G!=14:  # bilinear resize of position embeddings
    from PIL import Image
    pos=np.stack([np.asarray(Image.fromarray(pos[...,c]).resize((G,G),Image.BILINEAR)) for c in range(768)],-1)
pos=pos.reshape(1,T,768).astype(np.float32)
inits=[]; nodes=[]; cnt=[0]
def C(arr,name=None):
    cnt[0]+=1; name=name or 'c%d'%cnt[0]; inits.append(nh.from_array(np.asarray(arr),name)); return name
def N(op,ins,**kw):
    cnt[0]+=1; o='t%d'%cnt[0]; nodes.append(h.make_node(op,ins,[o],**kw)); return o
def lin(x,k,b): return N('Add',[N('MatMul',[x,C(k)]),C(b)])
def ln(x,n): return N('LayerNormalization',[x,C(W[n+'/scale']),C(W[n+'/bias'])],axis=-1,epsilon=1e-6)
def heads(x,n,w,TT):  # (B,TT,768)->(B,12,TT,64)
    y=lin(x,W[n+'/'+w+'/kernel'].reshape(768,768),W[n+'/'+w+'/bias'].reshape(768))
    return N('Transpose',[N('Reshape',[y,C(np.array([-1,TT,12,64],np.int64))])],perm=[0,2,1,3])
def attn(qh,x,n,TQ):
    k=heads(x,n,'key',T); v=heads(x,n,'value',T)
    a=N('Softmax',[N('Mul',[N('MatMul',[qh,N('Transpose',[k],perm=[0,1,3,2])]),C(np.array(0.125,np.float32))])],axis=-1)
    o=N('Reshape',[N('Transpose',[N('MatMul',[a,v])],perm=[0,2,1,3]),C(np.array([-1,TQ,768],np.int64))])
    return lin(o,W[n+'/out/kernel'].reshape(768,768),W[n+'/out/bias'])
def gelu(x):
    x3=N('Mul',[N('Mul',[x,x]),x]); inner=N('Mul',[N('Add',[x,N('Mul',[x3,C(np.array(0.044715,np.float32))])]),C(np.array(0.7978845608,np.float32))])
    return N('Mul',[N('Mul',[x,C(np.array(0.5,np.float32))]),N('Add',[N('Tanh',[inner]),C(np.array(1.0,np.float32))])])
def mlp(x,n): return lin(gelu(lin(x,W[n+'/Dense_0/kernel'],W[n+'/Dense_0/bias'])),W[n+'/Dense_1/kernel'],W[n+'/Dense_1/bias'])
# input: (B,RES,RES,3) RGB 0..255
x=N('Sub',[N('Div',['pixels',C(np.array(127.5,np.float32))]),C(np.array(1.0,np.float32))])
x=N('Reshape',[x,C(np.array([-1,G,16,G,16,3],np.int64))]); x=N('Transpose',[x],perm=[0,1,3,2,4,5])
x=N('Reshape',[x,C(np.array([-1,T,768],np.int64))])
x=N('Add',[lin(x,W['embedding/kernel'].reshape(768,768),W['embedding/bias']),C(pos)])
for i in range(12):
    n='Transformer/encoderblock_%d/'%i
    y=ln(x,n+'LayerNorm_0'); x=N('Add',[x,attn(heads(y,n+'MultiHeadDotProductAttention_0','query',T),y,n+'MultiHeadDotProductAttention_0',T)])
    y=ln(x,n+'LayerNorm_1'); x=N('Add',[x,mlp(y,n+'MlpBlock_0')])
x=ln(x,'Transformer/encoder_norm')
m='MAPHead_0/MultiHeadDotProductAttention_0'
q=(W['MAPHead_0/probe'].reshape(1,768)@W[m+'/query/kernel'].reshape(768,768)+W[m+'/query/bias'].reshape(768)).reshape(1,1,12,64).transpose(0,2,1,3)
x=attn(C(q.astype(np.float32)),x,m,1)
y=ln(x,'MAPHead_0/LayerNorm_0'); x=N('Add',[x,mlp(y,'MAPHead_0/MlpBlock_0')])
x=N('Reshape',[x,C(np.array([-1,768],np.int64))])
nrm=N('Sqrt',[N('ReduceSum',[N('Mul',[x,x]),C(np.array([1],np.int64))],keepdims=1)])
nodes.append(h.make_node('Div',[x,nrm],['embedding']))
g=h.make_graph(nodes,'siglip_b16_img',[h.make_tensor_value_info('pixels',TP.FLOAT,['B',RES,RES,3])],[h.make_tensor_value_info('embedding',TP.FLOAT,['B',768])],inits)
mod=h.make_model(g,opset_imports=[h.make_opsetid('',17)]); mod.ir_version=8
onnx.save(mod,'siglip_%d.onnx'%RES); print('saved')
