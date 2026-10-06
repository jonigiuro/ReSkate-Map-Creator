import * as THREE from 'three'

/**
 * Blueprint paper with world-locked pixel blocks (about 0.22 m),
 * a thin 1 m line, and a slightly stronger 10 m line. Horizontal faces
 * carry the full grid; edges are darker.
 */
export function createBlueprintMaterial(opacity = 1) {
  return new THREE.ShaderMaterial({
    toneMapped: false,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    uniforms: {
      uPaper: { value: new THREE.Color('#d7e4ee') },
      uMinor: { value: new THREE.Color('#b4d0dc') },
      uMajor: { value: new THREE.Color('#8eb4c6') },
      uOpacity: { value: opacity },
    },
    vertexShader: `
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      varying vec3 vWorld;
      varying vec3 vNormal;
      uniform vec3 uPaper;
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      uniform float uOpacity;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float gridLine(float coord, float spacing, float width) {
        float dist = abs(fract(coord / spacing - 0.5) - 0.5) * spacing;
        return 1.0 - smoothstep(width * 0.35, width, dist);
      }

      void main() {
        vec3 n = normalize(vNormal);
        vec2 plane = abs(n.y) > 0.6 ? vWorld.xz : abs(n.x) > abs(n.z) ? vWorld.zy : vWorld.xy;
        float up = smoothstep(0.45, 0.9, abs(n.y));

        float block = hash(floor(plane / 0.5));
        vec3 paper = uPaper + (block - 0.5) * 0.22;
        paper = mix(paper * 0.78, paper, up);

        float px = max(fwidth(plane.x), fwidth(plane.y));
        float minor = max(gridLine(plane.x, 1.0, px * 0.55), gridLine(plane.y, 1.0, px * 0.55));
        float major = max(gridLine(plane.x, 10.0, px * 1.05), gridLine(plane.y, 10.0, px * 1.05));
        float gridAmt = mix(0.35, 1.0, up);

        vec3 color = mix(paper, uMinor, minor * 0.45 * gridAmt);
        color = mix(color, uMajor, major * 0.5 * gridAmt);
        gl_FragColor = vec4(color, uOpacity);
      }
    `,
  })
}
