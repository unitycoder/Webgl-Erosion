import {mat4, vec2, vec3, vec4} from 'gl-matrix';
import * as Stats from 'stats-js';
import * as DAT from 'dat-gui';
import Square from './geometry/Square';
import Plane from './geometry/Plane';
import OpenGLRenderer from './rendering/gl/OpenGLRenderer';
import Camera from './Camera';
import {gl, setGL} from './globals';
import ShaderProgram, {Shader} from './rendering/gl/ShaderProgram';




var mouseChange = require('mouse-change');
var clientWidth : number;
var clientHeight : number;
var lastX = 0;
var lastY = 0;

const simresolution = 1000;
let erosioninterations = 68000;
let speed = 3;
const div = 1/simresolution;
let start = false;
let SimFramecnt = 0;
let TerrainGeometryDirty = true;
let PauseGeneration = true;
let HightMapCpuBuf = new Float32Array(simresolution * simresolution * 4);
let HightMapBufCounter  = 0;
let MaxHightMapBufCounter = 60; // determine how many frame to update CPU buffer of terrain hight map for ray casting on CPU



const controls = {
  tesselations: 5,
    pipelen: div/1.0,//
    Kc : 0.01,
    Ks : 0.0004,
    Kd : 0.0003,
    timestep : 0.001,
    pipeAra : div*div/1.0,
    EvaporationDegree : 0.02,
    RainDegree : 0.5,
    spawnposx : 0.5,
    spawnposy : 0.5,
    'Load Scene': loadScene, // A function pointer, essentially
    'Start/Resume' :StartGeneration,
    'Reset' : Reset,
    'setTerrainRandom':setTerrainRandom,
    'Pause' : Pause,
    TerrainBaseMap : 0,
    TerrainBiomeType : 1,
    TerrainScale : 4.0,
    TerrainDebug : 0,
    WaterTransparency : 0.50,
    brushType : 0, // 0 : no brush, 1 : terrain, 2 : water
    brushSize : 2,
    brushOperation : 0, // 0 : add, 1 : subtract
    brushPressed : 0, // 0 : not pressed, 1 : pressed
};


function StartGeneration(){
    PauseGeneration = false;
}
//geometries
let square: Square;
let plane : Plane;
let waterPlane : Plane;
//simulation variables
// texture structure : R : terrain hight map, G : water carrying, B : sediment carrying
let simres : number = simresolution;
let frame_buffer : WebGLFramebuffer;
let read_terrain_tex : WebGLTexture;
let write_terrain_tex : WebGLTexture;
let read_flux_tex : WebGLTexture;
let write_flux_tex : WebGLTexture;
let read_vel_tex : WebGLTexture;
let write_vel_tex : WebGLTexture;
let read_sediment_tex : WebGLTexture;
let write_sediment_tex : WebGLTexture;
let render_buffer : WebGLRenderbuffer;
let terrain_nor : WebGLTexture;
let num_simsteps : number;

function loadScene() {
  square = new Square(vec3.fromValues(0, 0, 0));
  square.create();
  plane = new Plane(vec3.fromValues(0,0,0), vec2.fromValues(1,1), 22);
  plane.create();
  waterPlane = new Plane(vec3.fromValues(0,0,0), vec2.fromValues(1,1), 22);
  waterPlane.create();
}

function Pause(){
    PauseGeneration = true;
}

function Reset(){
    SimFramecnt = 0;
    TerrainGeometryDirty = true;
    PauseGeneration = true;
}

function setTerrainRandom() {
}

function Render2Texture(renderer:OpenGLRenderer, gl:WebGL2RenderingContext,camera:Camera,shader:ShaderProgram,cur_texture:WebGLTexture){
    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);

    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,cur_texture,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);

    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    renderer.clear();
    shader.use();

    renderer.render(camera,shader,[square]);
    if(cur_texture == read_terrain_tex){
        HightMapCpuBuf = new Float32Array(simres * simres * 4);
        gl.readPixels(0,0,simres,simres, gl.RGBA, gl.FLOAT, HightMapCpuBuf);
        console.log(HightMapCpuBuf);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
}



function SimulatePerStep(renderer:OpenGLRenderer,
                         gl:WebGL2RenderingContext,
                         camera:Camera,
                         shader:ShaderProgram,
                         waterhight:ShaderProgram,
                         sedi:ShaderProgram,
                         advect:ShaderProgram,
                         rains:ShaderProgram,
                         eva:ShaderProgram,
                         ave:ShaderProgram) {


    //////////////////////////////////////////////////////////////////
    //rain precipitation
    //0---use hight map to derive hight map : hight map -----> hight map
    //////////////////////////////////////////////////////////////////

    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);


    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,write_terrain_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,null,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT2,gl.TEXTURE_2D,null,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);

    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);

    renderer.clear();
    rains.use();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    let readUnifr = gl.getUniformLocation(rains.prog,"readTerrain");
    gl.uniform1i(readUnifr,0);

    let raind = gl.getUniformLocation(rains.prog,'raindeg');
    gl.uniform1f(raind,controls.RainDegree);

    renderer.render(camera,rains,[square]);


    if(HightMapBufCounter % MaxHightMapBufCounter == 0) {
        gl.readPixels(0, 0, simres, simres, gl.RGBA, gl.FLOAT, HightMapCpuBuf);
    }
    HightMapBufCounter ++;

    gl.bindFramebuffer(gl.FRAMEBUFFER,null);


    //swap terrain tex-----------------------------------------------

    let tmp = read_terrain_tex;
    read_terrain_tex = write_terrain_tex;
    write_terrain_tex = tmp;

    //swap terrain tex-----------------------------------------------


    //////////////////////////////////////////////////////////////////
    //1---use hight map to derive flux map : hight map -----> flux map
    //////////////////////////////////////////////////////////////////
    
    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);

    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,write_flux_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,null,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT2,gl.TEXTURE_2D,null,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);

    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    
    renderer.clear();
    shader.use();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    let readUnif = gl.getUniformLocation(shader.prog,"readTerrain");
    gl.uniform1i(readUnif,0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,read_flux_tex);
    let readfluxUniff = gl.getUniformLocation(shader.prog,"readFlux");
    gl.uniform1i(readfluxUniff,1);

    renderer.render(camera,shader,[square]);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);

    
    
    //-----swap flux ping and pong


    tmp = read_flux_tex;
    read_flux_tex = write_flux_tex;
    write_flux_tex = tmp;
    
    //-----swap flux ping and pong

    //////////////////////////////////////////////////////////////////
    //2---use flux map and hight map to derive velocity map and new hight map :
    // hight map + flux map -----> velocity map + hight map
    //////////////////////////////////////////////////////////////////
    
    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,write_terrain_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,write_vel_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT2,gl.TEXTURE_2D,null,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);

    gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);

    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);

    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);

    renderer.clear();
    waterhight.use();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    let readterrainUnifw = gl.getUniformLocation(waterhight.prog,"readTerrain");
    gl.uniform1i(readterrainUnifw,0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,read_flux_tex);
    let readfluxUnifw = gl.getUniformLocation(waterhight.prog,"readFlux");
    gl.uniform1i(readfluxUnifw,1);


    renderer.render(camera,waterhight,[square]);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);


    //-----swap terrain ping and pong and velocity ping pong

    tmp = read_terrain_tex;
    read_terrain_tex = write_terrain_tex;
    write_terrain_tex = tmp;

    tmp = read_vel_tex;
    read_vel_tex = write_vel_tex;
    write_vel_tex = tmp;

    //-----swap flux ping and pong and velocity ping pong

    //////////////////////////////////////////////////////////////////
    //3---use velocity map, sediment map and hight map to derive sediment map and new hight map :
    // hight map + velocity map + sediment map -----> sediment map + hight map + terrain normal map
    //////////////////////////////////////////////////////////////////

    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);

    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,write_terrain_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,write_sediment_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT2,gl.TEXTURE_2D,terrain_nor,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);

    gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1,gl.COLOR_ATTACHMENT2]);

    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);

    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);

    renderer.clear();
    sedi.use();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    let readterrainUnifs = gl.getUniformLocation(sedi.prog,"readTerrain");
    gl.uniform1i(readterrainUnifs,0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,read_vel_tex);
    let readvelUnifs = gl.getUniformLocation(sedi.prog,"readVelocity");
    gl.uniform1i(readvelUnifs,1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D,read_sediment_tex);
    let readsediUnifs = gl.getUniformLocation(sedi.prog,"readSediment");
    gl.uniform1i(readsediUnifs,2);

    renderer.render(camera,sedi,[square]);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);


    //----------swap terrain and sediment map---------

    tmp = read_sediment_tex;
    read_sediment_tex = write_sediment_tex;
    write_sediment_tex = tmp;

    tmp = read_terrain_tex;
    read_terrain_tex = write_terrain_tex;
    write_terrain_tex = tmp;

    //----------swap terrain and sediment map---------

    //////////////////////////////////////////////////////////////////
    // semi-lagrangian advection for sediment transportation
    // 4---use velocity map, sediment map to derive new sediment map :
    // velocity map + sediment map -----> sediment map
    //////////////////////////////////////////////////////////////////

    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);

    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,write_sediment_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,null,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT2,gl.TEXTURE_2D,null,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);

    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);

    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);


    renderer.clear();
    advect.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_vel_tex);
    let readvelUnifa = gl.getUniformLocation(advect.prog,"vel");
    gl.uniform1i(readvelUnifa,0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,read_sediment_tex);
    let readsediUnifa = gl.getUniformLocation(advect.prog,"sedi");
    gl.uniform1i(readsediUnifa,1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D,null);

    renderer.render(camera,advect,[square]);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);

    //----------swap sediment map---------

    tmp = read_sediment_tex;
    read_sediment_tex = write_sediment_tex;
    write_sediment_tex = tmp;

    //----------swap sediment map---------

    //////////////////////////////////////////////////////////////////
    // water level evaporation at end of each iteration
    // 5---use terrain map to derive new terrain map :
    // terrain map -----> terrain map
    //////////////////////////////////////////////////////////////////

    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);

    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,write_terrain_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,null,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT2,gl.TEXTURE_2D,null,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);

    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);

    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);

    renderer.clear();
    eva.use();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    let readterrainUnife = gl.getUniformLocation(eva.prog,"terrain");
    gl.uniform1i(readterrainUnife,0);

    let erapodegree = gl.getUniformLocation(eva.prog,'evapod');
    gl.uniform1f(erapodegree,controls.EvaporationDegree);

    renderer.render(camera,eva,[square]);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);


    //---------------swap terrain mao----------------------------

    tmp = read_terrain_tex;
    read_terrain_tex = write_terrain_tex;
    write_terrain_tex = tmp;

    //---------------swap terrain mao----------------------------

    //////////////////////////////////////////////////////////////////
    // final average step : average terrain to avoid extremly sharp ridges or ravines
    // 6---use terrain map to derive new terrain map :
    //  terrain map -----> terrain map
    //////////////////////////////////////////////////////////////////
    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);

    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,write_terrain_tex,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,null,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT2,gl.TEXTURE_2D,null,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,render_buffer);

    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.log( "frame buffer status:" + status.toString());
    }

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    gl.viewport(0,0,simres,simres);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame_buffer);
    renderer.clear();
    ave.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    readterrainUnife = gl.getUniformLocation(ave.prog,"readTerrain");
    gl.uniform1i(readterrainUnife,0);
    renderer.render(camera,ave,[square]);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    //---------------swap terrain mao----------------------------

    tmp = read_terrain_tex;
    read_terrain_tex = write_terrain_tex;
    write_terrain_tex = tmp;

    //---------------swap terrain mao----------------------------
}



function setupFramebufferandtextures(gl:WebGL2RenderingContext) {
    frame_buffer = gl.createFramebuffer();

    //Noise generated data from GPU texture, include population density, water distribution, terrain elevation...
    read_terrain_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    write_terrain_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,write_terrain_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    read_flux_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,read_flux_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    write_flux_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,write_flux_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    read_vel_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,read_vel_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    write_vel_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,write_vel_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    read_sediment_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,read_sediment_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);


    write_sediment_tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,write_sediment_tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    terrain_nor = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,terrain_nor);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,simres,simres,0,
        gl.RGBA,gl.FLOAT,null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);



    //specify our render buffer here
    render_buffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER,render_buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,
        simres,simres);

    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
}



function SimulationStep(curstep:number,
                        flow:ShaderProgram,
                        waterhight : ShaderProgram,
                        sediment : ShaderProgram,
                        advect:ShaderProgram,
                        rains:ShaderProgram,
                        evapo:ShaderProgram,
                        average:ShaderProgram,
                        renderer:OpenGLRenderer, 
                        gl:WebGL2RenderingContext,camera:Camera){
    if(curstep>num_simsteps||PauseGeneration) return true;
    else{
        SimulatePerStep(renderer,
            gl,camera,flow,waterhight,sediment,advect,rains,evapo,average);
    }
    return false;
}

function handleInteraction (buttons : number, x : number, y : number){
    lastX = x;
    lastY = y;
}

function onKeyDown(event : KeyboardEvent){
    if(event.key == 'c'){
        controls.brushPressed = 1;
    }else{
        controls.brushPressed = 0;
    }

}

function onKeyUp(event : KeyboardEvent){
    if(event.key == 'c'){
        controls.brushPressed = 0;
    }
}

function main() {
  // Initial display for framerate
  const stats = Stats();
  stats.setMode(0);
  stats.domElement.style.position = 'absolute';
  stats.domElement.style.left = '0px';
  stats.domElement.style.top = '0px';
  document.body.appendChild(stats.domElement);

  // Add controls to the gui
  const gui = new DAT.GUI();
  // gui.add(controlsBarrier,'TerrainBaseMap',{defaultTerrain : 0, randomrizedTerrain :1});
  // gui.add(controlsBarrier,'TerrainBiomeType',{mountain:0,desert:1,volcanic:2});
    var simcontrols = gui.addFolder('Simulation Controls');
    simcontrols.add(controls,'Start/Resume');
    simcontrols.add(controls,'Pause');
    simcontrols.add(controls,'Reset');
    simcontrols.open();
    var terrainParameters = gui.addFolder('Terrain Parameters');
    terrainParameters.add(controls,'TerrainScale', 1.0, 10.0);
    terrainParameters.open();
    var erosionpara = gui.addFolder('Erosion Parameters');
    erosionpara.add(controls, 'EvaporationDegree', 0.0001, 0.08);
    erosionpara.add(controls,'RainDegree', 0.1,0.9);
    erosionpara.add(controls,'Kc', 0.002,0.04);
    erosionpara.add(controls,'Ks', 0.0001,0.0009);
    erosionpara.add(controls,'Kd', 0.0001,0.0009);
    erosionpara.add(controls, 'TerrainDebug', {normal : 0, sediment : 1, velocity : 2, terrain : 3, flux : 4});
    erosionpara.open();
    var terraineditor = gui.addFolder('Terrain Editor');
    terraineditor.add(controls,'brushType',{NoBrush : 0, TerrainBrush : 1, WaterBrush : 2});
    terraineditor.add(controls,'brushSize',1.0, 5.0);
    terraineditor.add(controls,'brushOperation', {Add : 0, Subtract : 1});
    terraineditor.open();
    var renderingpara = gui.addFolder('Rendering Parameters');
    renderingpara.add(controls, 'WaterTransparency', 0.0, 1.0);
    renderingpara.open();
  // gui.add(controls, 'spawnposx' ,0.0, 1.0);
  // gui.add(controls, 'spawnposy' ,0.0, 1.0);
  //gui.add(controls,'setTerrainRandom');

  /*
  gui.add(controls,"pipelen",div/20,div*4).step(div/20);
  gui.add(controls,'Kc',0.0,.1).step(0.0001);
  gui.add(controls,'Ks',0.0,.1).step(0.0001);
  gui.add(controls,'Kd',0.0,.1).step(0.0001);
  gui.add(controls,'timestep',0.0000001,.001).step(0.0000001);
  gui.add(controls,'pipeAra',0.01*div*div,2*div*div).step(0.01*div*div);
  */

  // get canvas and webgl context
  const canvas = <HTMLCanvasElement> document.getElementById('canvas');
  const gl = <WebGL2RenderingContext> canvas.getContext('webgl2');

  clientWidth = canvas.clientWidth;
  clientHeight = canvas.clientHeight;

  mouseChange(canvas, handleInteraction);
  document.addEventListener('keydown', onKeyDown, false);
  document.addEventListener('keyup', onKeyUp, false);

    if (!gl) {
    alert('WebGL 2 not supported!');
  }
  if(!gl.getExtension('OES_texture_float_linear')){
        console.log("float texture not supported");
    }
  if(!gl.getExtension('EXT_color_buffer_float')) {
      console.log("cant render to float texture because ur browser is stupid...");
  }
  // `setGL` is a function imported above which sets the value of `gl` in the `globals.ts` module.
  // Later, we can import `gl` from `globals.ts` to access it
  setGL(gl);

  // Initial call to load scene
  loadScene();
  num_simsteps = erosioninterations;

  const camera = new Camera(vec3.fromValues(0, 0.6, -0.6), vec3.fromValues(0, 0, 0));
  const renderer = new OpenGLRenderer(canvas);
  renderer.setClearColor(0.0, 0.0, 0.0, 1);
  gl.enable(gl.DEPTH_TEST);

  setupFramebufferandtextures(gl);

  const lambert = new ShaderProgram([
    new Shader(gl.VERTEX_SHADER, require('./shaders/terrain-vert.glsl')),
    new Shader(gl.FRAGMENT_SHADER, require('./shaders/terrain-frag.glsl')),
  ]);

  const flat = new ShaderProgram([
    new Shader(gl.VERTEX_SHADER, require('./shaders/flat-vert.glsl')),
    new Shader(gl.FRAGMENT_SHADER, require('./shaders/flat-frag.glsl')),
  ]);

  const noiseterrain = new ShaderProgram([
      new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
      new Shader(gl.FRAGMENT_SHADER, require('./shaders/initial-frag.glsl')),
  ]);

  const flow = new ShaderProgram([
      new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
      new Shader(gl.FRAGMENT_SHADER, require('./shaders/flow-frag.glsl')),
  ]);

  const waterhight = new ShaderProgram([
      new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
      new Shader(gl.FRAGMENT_SHADER, require('./shaders/alterwaterhight-frag.glsl')),
  ]);

  const sediment = new ShaderProgram([
      new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
      new Shader(gl.FRAGMENT_SHADER, require('./shaders/sediment-frag.glsl')),
  ]);

  const sediadvect = new ShaderProgram([
      new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
      new Shader(gl.FRAGMENT_SHADER, require('./shaders/sediadvect-frag.glsl')),
  ]);

    const rains = new ShaderProgram([
        new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
        new Shader(gl.FRAGMENT_SHADER, require('./shaders/rain-frag.glsl')),
    ]);


    const evaporation = new ShaderProgram([
        new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
        new Shader(gl.FRAGMENT_SHADER, require('./shaders/eva-frag.glsl')),
    ]);

    const average = new ShaderProgram([
        new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
        new Shader(gl.FRAGMENT_SHADER, require('./shaders/average-frag.glsl')),
    ]);

    const clean = new ShaderProgram([
        new Shader(gl.VERTEX_SHADER, require('./shaders/quad-vert.glsl')),
        new Shader(gl.FRAGMENT_SHADER, require('./shaders/clean-frag.glsl')),
    ]);

    const water = new ShaderProgram([
        new Shader(gl.VERTEX_SHADER, require('./shaders/water-vert.glsl')),
        new Shader(gl.FRAGMENT_SHADER, require('./shaders/water-frag.glsl')),
    ]);


    noiseterrain.setRndTerrain(controls.TerrainBaseMap);
    noiseterrain.setTerrainType(controls.TerrainBiomeType);

    let timer = 0;
    function cleanUpTextures(){
        Render2Texture(renderer, gl, camera, clean, read_terrain_tex);
        Render2Texture(renderer, gl, camera, clean, read_vel_tex);
        Render2Texture(renderer, gl, camera, clean, read_flux_tex);
        Render2Texture(renderer, gl, camera, clean, read_sediment_tex);
        Render2Texture(renderer, gl, camera, clean, write_terrain_tex);
        Render2Texture(renderer, gl, camera, clean, write_vel_tex);
        Render2Texture(renderer, gl, camera, clean, write_flux_tex);
        Render2Texture(renderer, gl, camera, clean, write_sediment_tex);
        Render2Texture(renderer, gl, camera, clean, terrain_nor);

    }

    function rayCast(ro : vec3, rd : vec3){

        let res = vec2.fromValues(-10.0, -10.0);
        let cur = ro;
        let step = 0.01;
        for(let i = 0;i<100;++i){
            let curTexSpace = vec2.fromValues((cur[0] + .50)/1.0, (cur[2] + .50)/1.0);
            let scaledTexSpace = vec2.fromValues(curTexSpace[0] * simres, curTexSpace[1] * simres);
            vec2.floor(scaledTexSpace,scaledTexSpace);
            let hvalcoordinate = scaledTexSpace[1] * simres * 4 + scaledTexSpace[0] * 4 + 0;
            let hval = HightMapCpuBuf[hvalcoordinate];
            if(cur[1] <  hval){
                res = curTexSpace;
                console.log(curTexSpace);
                break;

            }
            let rdscaled = vec3.fromValues(rd[0] * step, rd[1] * step, rd[2] * step);

            vec3.add(cur,cur,rdscaled);
        }

        return res;
    }

  function tick() {


    // ================ ray casting ===================
    //===================================================
    var screenMouseX = lastX / clientWidth;
    var screenMouseY = lastY / clientHeight;
    //console.log(screenMouseX + ' ' + screenMouseY);

    let viewProj = mat4.create();
    let invViewProj = mat4.create();
    mat4.multiply(viewProj, camera.projectionMatrix, camera.viewMatrix);
    mat4.invert(invViewProj,viewProj);
    let mousePoint = vec4.fromValues(2.0 * screenMouseX - 1.0, 1.0 - 2.0 * screenMouseY, -1.0, 1.0);
    let mousePointEnd = vec4.fromValues(2.0 * screenMouseX - 1.0, 1.0 - 2.0 * screenMouseY, -0.0, 1.0);

    vec4.transformMat4(mousePoint,mousePoint,invViewProj);
    vec4.transformMat4(mousePointEnd,mousePointEnd,invViewProj);
    mousePoint[0] /= mousePoint[3];
    mousePoint[1] /= mousePoint[3];
    mousePoint[2] /= mousePoint[3];
    mousePoint[3] /= mousePoint[3];
    mousePointEnd[0] /= mousePointEnd[3];
    mousePointEnd[1] /= mousePointEnd[3];
    mousePointEnd[2] /= mousePointEnd[3];
    mousePointEnd[3] /= mousePointEnd[3];
    let dir = vec3.fromValues(mousePointEnd[0] - mousePoint[0], mousePointEnd[1] - mousePoint[1], mousePointEnd[2] - mousePoint[2]);
    vec3.normalize(dir,dir);
    let ro = vec3.fromValues(mousePoint[0], mousePoint[1], mousePoint[2]);


    //==========set initial terrain uniforms=================
    timer++;
    noiseterrain.setTime(timer);
    noiseterrain.setTerrainScale(controls.TerrainScale);


    if(TerrainGeometryDirty){

        cleanUpTextures();
        Render2Texture(renderer,gl,camera,noiseterrain,read_terrain_tex);
        Render2Texture(renderer,gl,camera,noiseterrain,write_terrain_tex);

        TerrainGeometryDirty = false;
    }

    //ray cast happens here
    let pos = vec2.fromValues(0.0, 0.0);
    pos = rayCast(ro, dir);

    //===================per tick uniforms==================

    rains.setSpawnPos(vec2.fromValues(controls.spawnposx, controls.spawnposy));
    rains.setTime(timer);
    flat.setTime(timer);
    lambert.setTerrainDebug(controls.TerrainDebug);
    water.setWaterTransparency(controls.WaterTransparency);
    lambert.setMouseWorldPos(mousePoint);
    lambert.setMouseWorldDir(dir);
    lambert.setBrushSize(controls.brushSize);
    lambert.setBrushType(controls.brushType);
    lambert.setBrushPos(pos);

    rains.setMouseWorldPos(mousePoint);
    rains.setMouseWorldDir(dir);
    rains.setBrushSize(controls.brushSize);
    rains.setBrushType(controls.brushType);
    rains.setBrushPressed(controls.brushPressed);
    rains.setBrushPos(pos);
    rains.setBrushOperation(controls.brushOperation);

    flow.setPipeLen(controls.pipelen);
    flow.setSimres(simresolution);
    flow.setTimestep(controls.timestep);
    flow.setPipeArea(controls.pipeAra);

    waterhight.setPipeLen(controls.pipelen);
    waterhight.setSimres(simresolution);
    waterhight.setTimestep(controls.timestep);

    sediment.setSimres(simresolution);
    sediment.setPipeLen(controls.pipelen);
    sediment.setKc(controls.Kc);
    sediment.setKs(controls.Ks);
    sediment.setKd(controls.Kd);
    sediment.setTimestep(controls.timestep)

    sediadvect.setSimres(simresolution);
    sediadvect.setPipeLen(controls.pipelen);
    sediadvect.setKc(controls.Kc);
    sediadvect.setKs(controls.Ks);
    sediadvect.setKd(controls.Kd);
    sediadvect.setTimestep(controls.timestep);

    average.setSimres(simresolution);

    camera.update();
    stats.begin();

    for(let i = 0;i<speed;i++) {
        SimulationStep(SimFramecnt, flow, waterhight, sediment, sediadvect,rains,evaporation,average, renderer, gl, camera);
        SimFramecnt++;
    }

    gl.viewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.clear();



    // render terrain -----------------------------------------
    lambert.use();
    //plane.setDrawMode(gl.LINE_STRIP);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    let PingUniform = gl.getUniformLocation(lambert.prog,"hightmap");
    gl.uniform1i(PingUniform,0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,terrain_nor);
    let norUniform = gl.getUniformLocation(lambert.prog,"normap");
    gl.uniform1i(norUniform,1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, read_sediment_tex);
    let sediUniform = gl.getUniformLocation(lambert.prog, "sedimap");
    gl.uniform1i(sediUniform, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, read_vel_tex);
    let velUniform = gl.getUniformLocation(lambert.prog, "velmap");
    gl.uniform1i(velUniform, 3);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, read_flux_tex);
    let fluxUniform = gl.getUniformLocation(lambert.prog, "fluxmap");
    gl.uniform1i(fluxUniform, 4);

    renderer.render(camera, lambert, [
      plane,
    ]);

    // render water -----------------------------------------
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    water.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,read_terrain_tex);
    PingUniform = gl.getUniformLocation(water.prog,"hightmap");
    gl.uniform1i(PingUniform,0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,terrain_nor);
    norUniform = gl.getUniformLocation(water.prog,"normap");
    gl.uniform1i(norUniform,1);
    renderer.render(camera, water, [
      plane,
    ]);
    gl.disable(gl.BLEND);

    // back ground ----------------------------------
    flat.use();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read_sediment_tex);
    let postUniform = gl.getUniformLocation(flat.prog,"hightmap");
    gl.uniform1i(postUniform,0);
    renderer.render(camera, flat, [
      square,
    ]);
    //gl.disable(gl.DEPTH_TEST);
    stats.end();

    // Tell the browser to call `tick` again whenever it renders a new frame
    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', function() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.setAspectRatio(window.innerWidth / window.innerHeight);
    camera.updateProjectionMatrix();
  }, false);

  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.setAspectRatio(window.innerWidth / window.innerHeight);
  camera.updateProjectionMatrix();

  // Start the render loop
  tick();
}

main();
