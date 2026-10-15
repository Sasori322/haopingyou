<script setup lang="ts">
import { computed } from 'vue'
import type { PetState } from '@shared/types/pet'

const props = withDefaults(
  defineProps<{
    kind?: 'cat' | 'dog'
    state?: PetState
    facing?: -1 | 1
  }>(),
  { kind: 'cat', state: 'idle', facing: 1 }
)

const eyesClosed = computed(() => props.state === 'sleep')
const panting = computed(() => props.state === 'hot')
const flip = computed(() => (props.facing === -1 ? 'scaleX(-1)' : 'none'))
</script>

<template>
  <div class="pet-sprite" :data-state="state">
    <div class="pet-flip" :style="{ transform: flip }">
      <!-- 小猫 -->
      <svg v-if="kind === 'cat'" viewBox="0 0 200 200" width="100%" height="100%">
        <ellipse cx="100" cy="191" rx="43" ry="6.5" fill="#000" opacity="0.10" />

        <!-- 尾巴 -->
        <path
          d="M146 158 C182 150 186 118 168 100"
          fill="none"
          stroke="#EDA05E"
          stroke-width="13"
          stroke-linecap="round"
        />

        <!-- 身体 -->
        <ellipse cx="100" cy="139" rx="45" ry="44" fill="#F3A961" />
        <ellipse cx="100" cy="149" rx="29" ry="32" fill="#FFE7CE" />
        <ellipse cx="77" cy="176" rx="15" ry="10" fill="#FFE7CE" />
        <ellipse cx="123" cy="176" rx="15" ry="10" fill="#FFE7CE" />

        <!-- 耳朵 -->
        <path d="M68 60 L61 20 L99 46 Z" fill="#F3A961" />
        <path d="M132 60 L139 20 L101 46 Z" fill="#F3A961" />
        <path d="M72 55 L68 31 L90 47 Z" fill="#E8836B" />
        <path d="M128 55 L132 31 L110 47 Z" fill="#E8836B" />

        <!-- 头 -->
        <circle cx="100" cy="85" r="41" fill="#F3A961" />
        <path d="M100 48 L100 60" stroke="#E0913F" stroke-width="4" stroke-linecap="round" />
        <path d="M86 49 L89 59" stroke="#E0913F" stroke-width="4" stroke-linecap="round" />
        <path d="M114 49 L111 59" stroke="#E0913F" stroke-width="4" stroke-linecap="round" />

        <!-- 眼睛 -->
        <template v-if="eyesClosed">
          <path
            d="M77 86 Q84 93 91 86"
            fill="none"
            stroke="#3F2C22"
            stroke-width="3.4"
            stroke-linecap="round"
          />
          <path
            d="M109 86 Q116 93 123 86"
            fill="none"
            stroke="#3F2C22"
            stroke-width="3.4"
            stroke-linecap="round"
          />
        </template>
        <template v-else>
          <ellipse cx="84" cy="85" rx="7" ry="9.5" fill="#3F2C22" />
          <ellipse cx="116" cy="85" rx="7" ry="9.5" fill="#3F2C22" />
          <circle cx="86.5" cy="81" r="2.6" fill="#fff" />
          <circle cx="118.5" cy="81" r="2.6" fill="#fff" />
        </template>

        <!-- 鼻子与嘴 -->
        <path d="M100 100 L93.5 94.5 L106.5 94.5 Z" fill="#E8836B" />
        <path
          d="M100 101 Q94 109 88 103"
          fill="none"
          stroke="#3F2C22"
          stroke-width="2.6"
          stroke-linecap="round"
        />
        <path
          d="M100 101 Q106 109 112 103"
          fill="none"
          stroke="#3F2C22"
          stroke-width="2.6"
          stroke-linecap="round"
        />

        <!-- 胡须 -->
        <path d="M58 88 L38 84 M58 96 L39 98" stroke="#C98A55" stroke-width="2" stroke-linecap="round" />
        <path d="M142 88 L162 84 M142 96 L161 98" stroke="#C98A55" stroke-width="2" stroke-linecap="round" />

        <!-- 热 / 困 的小标记 -->
        <g v-if="panting">
          <path d="M140 62 q8 10 0 16 q-8 -6 0 -16 Z" fill="#7FC4F0" />
          <path d="M52 70 q6 8 0 12 q-6 -4 0 -12 Z" fill="#7FC4F0" />
        </g>
        <g v-if="eyesClosed" fill="#8A9AA8" font-family="system-ui" font-weight="700">
          <text x="146" y="52" font-size="16">z</text>
          <text x="158" y="38" font-size="20">z</text>
        </g>
      </svg>

      <!-- 小狗 -->
      <svg v-else viewBox="0 0 200 200" width="100%" height="100%">
        <ellipse cx="100" cy="191" rx="43" ry="6.5" fill="#000" opacity="0.10" />

        <!-- 尾巴 -->
        <path
          d="M150 150 C176 138 178 116 164 104"
          fill="none"
          stroke="#C99A6E"
          stroke-width="13"
          stroke-linecap="round"
        />

        <!-- 身体 -->
        <ellipse cx="100" cy="140" rx="44" ry="43" fill="#D3A87C" />
        <ellipse cx="100" cy="152" rx="28" ry="31" fill="#F6E5D2" />
        <ellipse cx="77" cy="176" rx="15" ry="10" fill="#F6E5D2" />
        <ellipse cx="123" cy="176" rx="15" ry="10" fill="#F6E5D2" />

        <!-- 垂耳 -->
        <ellipse cx="60" cy="90" rx="14" ry="27" fill="#B98757" transform="rotate(-14 60 90)" />
        <ellipse cx="140" cy="90" rx="14" ry="27" fill="#B98757" transform="rotate(14 140 90)" />

        <!-- 头 -->
        <circle cx="100" cy="88" r="40" fill="#D3A87C" />
        <ellipse cx="100" cy="105" rx="24" ry="17" fill="#F6E5D2" />

        <!-- 眼睛 -->
        <template v-if="eyesClosed">
          <path
            d="M78 82 Q85 89 92 82"
            fill="none"
            stroke="#3F2C22"
            stroke-width="3.4"
            stroke-linecap="round"
          />
          <path
            d="M108 82 Q115 89 122 82"
            fill="none"
            stroke="#3F2C22"
            stroke-width="3.4"
            stroke-linecap="round"
          />
        </template>
        <template v-else>
          <ellipse cx="85" cy="81" rx="6.5" ry="8.5" fill="#3F2C22" />
          <ellipse cx="115" cy="81" rx="6.5" ry="8.5" fill="#3F2C22" />
          <circle cx="87" cy="78" r="2.4" fill="#fff" />
          <circle cx="117" cy="78" r="2.4" fill="#fff" />
        </template>

        <!-- 鼻子与嘴 -->
        <ellipse cx="100" cy="98" rx="8" ry="5.6" fill="#4A3327" />
        <path
          d="M100 104 L100 109"
          stroke="#4A3327"
          stroke-width="2.6"
          stroke-linecap="round"
        />
        <path
          d="M100 109 Q93 115 87 109"
          fill="none"
          stroke="#4A3327"
          stroke-width="2.6"
          stroke-linecap="round"
        />
        <path
          d="M100 109 Q107 115 113 109"
          fill="none"
          stroke="#4A3327"
          stroke-width="2.6"
          stroke-linecap="round"
        />
        <path v-if="panting" d="M94 110 q6 12 12 0 q-6 3 -12 0 Z" fill="#EE8B93" />

        <g v-if="panting">
          <path d="M142 60 q8 10 0 16 q-8 -6 0 -16 Z" fill="#7FC4F0" />
        </g>
        <g v-if="eyesClosed" fill="#8A9AA8" font-family="system-ui" font-weight="700">
          <text x="146" y="52" font-size="16">z</text>
          <text x="158" y="38" font-size="20">z</text>
        </g>
      </svg>
    </div>
  </div>
</template>
