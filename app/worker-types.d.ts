declare module '*?worker' {
  const WorkerConstructor:new(options?:{name?:string})=>Worker;
  export default WorkerConstructor;
}
